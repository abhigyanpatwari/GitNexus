import * as t from '@babel/types';
import { generate } from '@babel/generator';
import { resolveName } from '../../test-dupes/test-dupes.js';
import type { RowValue } from '../types.js';
import {
  abstractNode,
  buildScope,
  rowValueOf,
  type CheckSubject,
  type InstanceChecks,
  type Scope,
} from '../facet/checks.js';
import { sha1, sortedUnique } from '../util.js';

export interface AssertionAtom {
  line: number;
  shape: string;
  shapeKey: string;
  /** Exact expected literals/snapshot and subject shape, or null for unresolved values. */
  key: string | null;
  expected: string | null;
  observed?: string | null;
}
export interface AssertionEvidence {
  atoms: AssertionAtom[];
  unresolved: string[];
}

function canonicalRow(row: RowValue): unknown | undefined {
  if (row.kind === 'unresolved') return undefined;
  if (row.kind === 'array') {
    const items = row.items.map(canonicalRow);
    return items.includes(undefined) ? undefined : { kind: 'array', items };
  }
  if (row.kind === 'object') {
    const entries = row.entries
      .map(({ key, value }) => ({ key, value: canonicalRow(value) }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return entries.some((entry) => entry.value === undefined)
      ? undefined
      : { kind: 'object', entries };
  }
  return row;
}

function literal(node: t.Node, scope: Scope): unknown | undefined {
  if (t.isTSAsExpression(node) || t.isTSNonNullExpression(node) || t.isTSTypeAssertion(node))
    return literal(node.expression, scope);
  const row = rowValueOf(node, scope);
  if (row !== null) return row === 'unknown' ? undefined : canonicalRow(row);
  if (t.isStringLiteral(node)) return { kind: 'string', value: node.value };
  if (t.isNumericLiteral(node)) return { kind: 'number', text: String(node.value) };
  if (t.isBooleanLiteral(node)) return { kind: 'boolean', value: node.value };
  if (t.isNullLiteral(node)) return { kind: 'null' };
  if (t.isBigIntLiteral(node)) return { kind: 'bigint', text: String(node.value) };
  if (t.isRegExpLiteral(node)) return { kind: 'regexp', pattern: node.pattern, flags: node.flags };
  if (
    t.isIdentifier(node, { name: 'undefined' }) &&
    !scope.locals.has('undefined') &&
    resolveName('undefined', scope.record.chain) === undefined
  )
    return { kind: 'undefined' };
  if (t.isUnaryExpression(node) && ['-', '+', '!'].includes(node.operator)) {
    if (t.isNumericLiteral(node.argument) && node.operator !== '!') {
      const value = node.operator === '-' ? -node.argument.value : +node.argument.value;
      return { kind: 'number', text: Object.is(value, -0) ? '-0' : String(value) };
    }
    if (t.isBigIntLiteral(node.argument) && node.operator === '-')
      return { kind: 'bigint', text: String(-BigInt(node.argument.value)) };
    return undefined;
  }
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    !node.callee.computed &&
    t.isIdentifier(node.callee.object, { name: 'expect' }) &&
    t.isIdentifier(node.callee.property) &&
    [
      'objectContaining',
      'arrayContaining',
      'stringContaining',
      'stringMatching',
      'closeTo',
    ].includes(node.callee.property.name)
  ) {
    const args = node.arguments.map((arg) => literal(arg, scope));
    return args.includes(undefined) ? undefined : { asymmetric: node.callee.property.name, args };
  }
  if (t.isTemplateLiteral(node) && node.expressions.length === 0)
    return { kind: 'string', value: node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw };
  if (t.isArrayExpression(node)) {
    const items = node.elements.map((item) =>
      item === null ? { kind: 'hole' } : literal(item, scope),
    );
    return items.includes(undefined) ? undefined : { kind: 'array', items };
  }
  if (t.isObjectExpression(node)) {
    const entries: { key: string; value: unknown }[] = [];
    for (const item of node.properties) {
      if (!t.isObjectProperty(item) || item.computed) return undefined;
      const key = t.isIdentifier(item.key)
        ? item.key.name
        : t.isStringLiteral(item.key) || t.isNumericLiteral(item.key)
          ? String(item.key.value)
          : null;
      const value = literal(item.value, scope);
      if (key === null || value === undefined) return undefined;
      entries.push({ key, value });
    }
    return { kind: 'object', entries: entries.sort((a, b) => a.key.localeCompare(b.key)) };
  }
  return undefined;
}

/** Expand only single, preceding const bindings. Ambiguous scopes and mutable locals stay unknown. */
function localOrigins(
  subject: CheckSubject,
  scope: Scope,
  before: number,
): (node: t.Node) => t.Node {
  const declarations = new Map<string, t.Node | null>();
  t.traverseFast(subject.record.fn.body, (node) => {
    if (!t.isVariableDeclaration(node)) return;
    for (const decl of node.declarations) {
      if (!t.isIdentifier(decl.id)) continue;
      const init = node.kind === 'const' && (decl.end ?? Infinity) < before ? decl.init : null;
      declarations.set(decl.id.name, declarations.has(decl.id.name) ? null : (init ?? null));
    }
  });
  let nextBinding = 0;
  let visited = 0;
  const expand = (
    node: t.Node,
    seen = new Set<string>(),
    bindings = new Map<string, t.Identifier>(),
  ): t.Node => {
    if (++visited > 5000 || seen.size > 32) {
      scope.unresolved.add('assertion origin expansion limit reached');
      const unknown = t.identifier('_unknown');
      unknown.name = '<unknown>';
      return unknown;
    }
    const bound = t.isIdentifier(node) ? bindings.get(node.name) : undefined;
    if (bound !== undefined) return bound;
    if (t.isIdentifier(node) && scope.locals.has(node.name)) {
      const init = declarations.get(node.name);
      if (!init || seen.has(node.name)) return node;
      return expand(init, new Set([...seen, node.name]), bindings);
    }
    const copy = t.cloneNode(node, false);
    if (t.isFunction(copy) && copy.params.every((param) => t.isIdentifier(param))) {
      bindings = new Map(bindings);
      copy.params = copy.params.map((param) => {
        const marker = t.identifier('_bound');
        marker.name = `<bound:${nextBinding++}>`;
        bindings.set((param as t.Identifier).name, marker);
        return marker;
      });
    }
    const object = copy as unknown as Record<string, unknown>;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      // Noncomputed property names are selectors, not references to local bindings.
      if (
        (key === 'property' &&
          (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
          !node.computed) ||
        (key === 'key' && t.isObjectProperty(node) && !node.computed)
      )
        continue;
      const value = object[key];
      object[key] = Array.isArray(value)
        ? value.map((child) => (t.isNode(child) ? expand(child, seen, bindings) : child))
        : t.isNode(value)
          ? expand(value, seen, bindings)
          : value;
    }
    return copy;
  };
  return (node) => {
    nextBinding = 0;
    visited = 0;
    return expand(node);
  };
}

function preserveValues(node: t.Node, scope: Scope): t.Node {
  const value = literal(node, scope);
  if (value !== undefined) {
    const marker = t.identifier('_value');
    marker.name = `<value:${JSON.stringify(value)}>`;
    return marker;
  }
  if (t.isIdentifier(node) && !scope.locals.has(node.name)) {
    const decl = resolveName(node.name, scope.record.chain);
    if (decl?.kind === 'import') {
      const marker = t.identifier('_import');
      marker.name = `<${decl.key}>`;
      return marker;
    }
  }
  if (t.isTemplateLiteral(node)) {
    const marker = t.identifier('_template');
    marker.name = '<template>';
    return t.callExpression(
      marker,
      node.quasis.flatMap((quasi, index) => [
        preserveValues(t.stringLiteral(quasi.value.cooked ?? quasi.value.raw), scope),
        ...(node.expressions[index]
          ? [preserveValues(node.expressions[index], scope) as t.Expression]
          : []),
      ]) as t.Expression[],
    );
  }
  const copy = t.cloneNode(node, false);
  const object = copy as unknown as Record<string, unknown>;
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    if (
      (key === 'property' &&
        (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
        !node.computed) ||
      (key === 'key' && t.isObjectProperty(node) && !node.computed)
    )
      continue;
    const child = object[key];
    object[key] = Array.isArray(child)
      ? child.map((v) => (t.isNode(v) ? preserveValues(v, scope) : v))
      : t.isNode(child)
        ? preserveValues(child, scope)
        : child;
  }
  return copy;
}

function assertedSubject(call: t.CallExpression): t.Node | null {
  let node: t.Node = call.callee;
  while (t.isMemberExpression(node)) node = node.object;
  if (!t.isCallExpression(node)) return null;
  if (
    !t.isIdentifier(node.callee, { name: 'expect' }) &&
    !(
      t.isMemberExpression(node.callee) &&
      !node.callee.computed &&
      t.isIdentifier(node.callee.object, { name: 'expect' }) &&
      t.isIdentifier(node.callee.property, { name: 'soft' })
    )
  )
    return null;
  const first = node.arguments[0];
  return first && !t.isSpreadElement(first) && !t.isArgumentPlaceholder(first) ? first : null;
}

/** Retain exact expected literals; never equate assertions solely because both expect a number. */
export function assertionEvidence(
  subject: CheckSubject,
  checks: InstanceChecks,
): AssertionEvidence {
  const scope = buildScope(subject);
  const calls: t.CallExpression[] = [];
  t.traverseFast(subject.record.fn.body, (node) => {
    if (t.isCallExpression(node)) calls.push(node);
  });
  calls.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const used = new Set<t.CallExpression>();
  const unresolved = [
    ...checks.unresolved,
    ...checks.unsupported.map((form) => `${form.line}: ${form.reason}`),
  ];
  const atoms: AssertionAtom[] = [];
  for (const check of checks.checks) {
    if (check.matcher === '') continue; // Counts of assertions are not behavioral checks.
    const call = calls.find(
      (node) =>
        !used.has(node) &&
        node.loc?.start.line === check.line &&
        t.isMemberExpression(node.callee) &&
        !node.callee.computed &&
        t.isIdentifier(node.callee.property, { name: check.matcher }) &&
        assertedSubject(node) !== null,
    );
    if (call === undefined) {
      unresolved.push(`${check.line}: assertion call not located`);
      continue;
    }
    used.add(call);
    const expand = localOrigins(subject, scope, call.start ?? 0);
    const values = call.arguments.map((arg) => literal(expand(arg), scope));
    const expected =
      check.snapshot !== null
        ? `snapshot:${check.snapshot}`
        : values.includes(undefined)
          ? null
          : JSON.stringify(values);
    if (expected === null) unresolved.push(`${check.line}: expected value is not static`);
    // Existing check.shape has the assertion parser's selector/negation rules.
    const observed = assertedSubject(call);
    const originNode =
      observed === null
        ? null
        : abstractNode(preserveValues(expand(observed), scope), scope, true, false);
    let knownOrigin = originNode !== null;
    if (originNode !== null)
      t.traverseFast(originNode, (node) => {
        if (t.isIdentifier(node) && /^(?:<v\d+>|<unknown>)$/.test(node.name)) knownOrigin = false;
      });
    const origin = originNode === null ? null : generate(originNode, { compact: true }).code;
    if (!knownOrigin) unresolved.push(`${check.line}: asserted local origin is unresolved`);
    const shapeKey = sha1(
      JSON.stringify([
        knownOrigin ? origin : check.shape,
        check.form,
        check.modifiers,
        check.matcher,
      ]),
    );
    atoms.push({
      line: check.line,
      shape: check.shape,
      shapeKey,
      expected,
      observed: origin,
      key:
        expected === null || !knownOrigin
          ? null
          : sha1(JSON.stringify([origin, check.form, check.modifiers, check.matcher, expected])),
    });
  }
  return { atoms, unresolved: sortedUnique([...unresolved, ...scope.unresolved]) };
}
