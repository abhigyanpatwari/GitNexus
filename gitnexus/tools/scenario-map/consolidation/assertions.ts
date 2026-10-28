import * as t from '@babel/types';
import traverse, { type Binding } from '@babel/traverse';
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
    const values = new Map<string, unknown>();
    for (const entry of row.entries) {
      const value = canonicalRow(entry.value);
      if (value === undefined) return undefined;
      values.set(entry.key, value);
    }
    const entries = [...values].map(([key, value]) => ({ key, value }));
    return { kind: 'object', entries: entries.sort((a, b) => a.key.localeCompare(b.key)) };
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
    const values = new Map<string, unknown>();
    for (const item of node.properties) {
      if (!t.isObjectProperty(item) || item.computed) return undefined;
      const key = t.isIdentifier(item.key)
        ? item.key.name
        : t.isStringLiteral(item.key) || t.isNumericLiteral(item.key)
          ? String(item.key.value)
          : null;
      const value = literal(item.value, scope);
      if (key === null || value === undefined) return undefined;
      values.set(key, value);
    }
    const entries = [...values].map(([key, value]) => ({ key, value }));
    return { kind: 'object', entries: entries.sort((a, b) => a.key.localeCompare(b.key)) };
  }
  return undefined;
}

/** Expand preceding immutable const bindings in their lexical scope. */
function localOrigins(
  subject: CheckSubject,
  scope: Scope,
): (node: t.Node, before: number) => t.Node {
  const references = new WeakSet<t.Node>();
  const declarations = new WeakMap<t.Node, Binding>();
  traverse(t.file(t.program([t.expressionStatement(subject.record.fn)])), {
    Identifier(path) {
      if (path.isReferencedIdentifier()) references.add(path.node);
      const binding = path.scope.getBinding(path.node.name);
      if (binding) declarations.set(path.node, binding);
    },
  });
  let nextBinding = 0;
  let visited = 0;
  const expand = (
    node: t.Node,
    before: number,
    seen = new Set<Binding>(),
    bindings = new Map<Binding, t.Identifier>(),
  ): t.Node => {
    const unknown = (): t.Identifier => {
      const marker = t.identifier('_unknown');
      marker.name = '<unknown>';
      return marker;
    };
    if (++visited > 5000 || seen.size > 32) {
      scope.unresolved.add('assertion origin expansion limit reached');
      return unknown();
    }
    const declaration = declarations.get(node);
    if (references.has(node) && declaration) {
      const bound = bindings.get(declaration);
      if (bound) return bound;
      // The inventory binds only the test callback's own parameters to table rows.
      if (declaration.kind === 'param' && declaration.scope.block === subject.record.fn)
        return node;
      const decl = declaration.path.node;
      if (
        declaration.kind !== 'const' ||
        !declaration.constant ||
        !t.isVariableDeclarator(decl) ||
        !t.isIdentifier(decl.id) ||
        !decl.init ||
        (decl.end ?? Infinity) >= before ||
        seen.has(declaration)
      )
        return unknown();
      return expand(decl.init, before, new Set([...seen, declaration]), bindings);
    }
    const copy = t.cloneNode(node, false);
    if (t.isFunction(copy) && copy.params.every((param) => t.isIdentifier(param))) {
      bindings = new Map(bindings);
      copy.params = copy.params.map((param) => {
        const marker = t.identifier('_bound');
        marker.name = `<bound:${nextBinding++}>`;
        const binding = declarations.get(param);
        if (binding) bindings.set(binding, marker);
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
        ? value.map((child) => (t.isNode(child) ? expand(child, before, seen, bindings) : child))
        : t.isNode(value)
          ? expand(value, before, seen, bindings)
          : value;
    }
    return copy;
  };
  return (node, before) => {
    nextBinding = 0;
    visited = 0;
    return expand(node, before);
  };
}

function helperIdentity(
  fn: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression,
  declaration: t.Node,
  scope: Scope,
): string | null {
  const copy = t.cloneNode(fn, true);
  const statement = t.isFunctionDeclaration(copy) ? copy : t.expressionStatement(copy);
  const frame = scope.record.chain.findIndex((item) =>
    [...item.decls.values()].some((decl) => decl.kind === 'node' && decl.node === declaration),
  );
  if (frame < 0) return null;
  const chain = scope.record.chain.slice(0, frame + 1);
  let closed = true;
  traverse(t.file(t.program([statement])), {
    ReferencedIdentifier(path) {
      if (path.scope.getBinding(path.node.name)) return;
      const decl = resolveName(path.node.name, chain);
      if (decl?.kind === 'import') path.node.name = `<${decl.key}>`;
      else closed = false;
    },
  });
  return closed ? sha1(generate(copy, { compact: true, comments: false }).code) : null;
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
    if (decl?.kind === 'node') {
      const fn = t.isVariableDeclarator(decl.node) ? decl.node.init : decl.node;
      if (
        t.isFunctionDeclaration(fn) ||
        t.isFunctionExpression(fn) ||
        t.isArrowFunctionExpression(fn)
      ) {
        const marker = t.identifier('_local');
        const identity = helperIdentity(fn, decl.node, scope);
        marker.name =
          identity === null
            ? `<local:${scope.record.file}:${decl.node.start}:${node.name}>`
            : `<helper:${identity}>`;
        return marker;
      }
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
  let origins: ReturnType<typeof localOrigins> | undefined;
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
    const expand = (origins ??= localOrigins(subject, scope));
    const before = call.start ?? 0;
    const values = call.arguments.map((arg) => literal(expand(arg, before), scope));
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
        : abstractNode(preserveValues(expand(observed, before), scope), scope, true, false);
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
