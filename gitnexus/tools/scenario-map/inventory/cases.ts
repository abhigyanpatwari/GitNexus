/**
 * Static test instances of the scenario map (U3, design §5.3, KTD3).
 *
 * Layer 0's extraction (tools/test-dupes) gives one `CaseRecord` per test call as written. This
 * module expands each call into the instances Vitest collects from it, in collection order, with
 * the values each instance binds:
 *  - the test's own `it.each` / `test.each` / `test.for` table (array, tagged template), mirroring
 *    Vitest 5: an `each` row is spread into the callback only when every row is an array, a `for`
 *    row never is, and a template table gives one object per row;
 *  - enclosing `describe.each` / `describe.for` tables, with the same rules;
 *  - enclosing `for…of` loops over a statically known array.
 * Outer constructs vary slowest, as in collection order.
 *
 * Tables evaluate statically: literals, arrays, objects, templates, arithmetic, `Number.*`
 * constants, `.slice()` and spreads, following `const` bindings (Babel scopes) whose array or
 * object value never escapes: every reference must be a table argument, a `for…of` source, an
 * `expect()` subject, a spread or `.slice()` copy that flows to the same places, a `.length` /
 * `.includes()` / `.indexOf()` / `.join()` read, a type query, or a primitive coercion. Anything
 * else (an assignment, a mutating or callback method, an argument to another function, an export)
 * may change the value, so the binding is not evaluated. Limits: an element mutated through an
 * alias (a `for…of` loop variable, or a test's own argument at run time) is not seen.
 *
 * Fail closed: a construct whose number of instances is not static (a computed table, another
 * loop, a test inside a helper or a callback such as `cases.forEach`) gives a call site without
 * instances, marked unresolved; a row whose count is known but whose values are not keeps its
 * place, with the unknown parts marked `unresolved`. Both block strong evidence.
 *
 * Each call site also carries the location Vitest reports for its tests (V8's position of the
 * call: the callee identifier, a member call's property, or the `(` of a call whose callee is
 * itself a call, such as `it.each(t)(…)`) and, when every title is a plain string, its full name.
 *
 * Library only; the scenario-map CLI (U14) calls {@link loadStaticInventory}.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generate } from '@babel/generator';
import traverse, { type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { TestLocation } from '../../mutation/runner/test-ids.js';
import {
  eachTableOf,
  extract,
  roleOf,
  shapeOf,
  type CaseRecord,
  type SourceFile,
} from '../../test-dupes/test-dupes.js';
import {
  fromPackagePath,
  toPackagePath,
  type DimensionKind,
  type InstanceDimension,
  type RowEntry,
  type RowValue,
  type StaticCallSite,
  type StaticInstance,
  type StaticInventory,
} from '../types.js';
import { sha1 } from '../util.js';

/** Nesting limit for `const` bindings followed while evaluating one value. */
const MAX_DEPTH = 8;
/** More instances than this at one call site are treated as not static. */
const MAX_INSTANCES = 10_000;
const TABLE_CALL_ROOTS = new Set(['it', 'test', 'describe', 'suite']);
const TABLE_MODIFIERS = new Set(['each', 'for']);
/** Array methods that read without mutating and return a primitive. */
const PRIMITIVE_READS = new Set(['length', 'includes', 'indexOf', 'lastIndexOf', 'join']);
const NUMBER_CONSTANTS: ReadonlyMap<string, number> = new Map([
  ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
  ['MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER],
  ['MAX_VALUE', Number.MAX_VALUE],
  ['MIN_VALUE', Number.MIN_VALUE],
  ['EPSILON', Number.EPSILON],
  ['POSITIVE_INFINITY', Number.POSITIVE_INFINITY],
  ['NEGATIVE_INFINITY', Number.NEGATIVE_INFINITY],
  ['NaN', Number.NaN],
]);

type AnyPath = NodePath<t.Node>;

const codeOf = (node: t.Node): string => generate(node, { comments: false, compact: true }).code;

// ── Row values ─────────────────────────────────────────────────────────────

const numberValue = (n: number): RowValue => ({
  kind: 'number',
  text: Object.is(n, -0) ? '-0' : String(n),
});
const UNDEFINED: RowValue = { kind: 'undefined' };
const unresolvedValue = (node: t.Node, reason: string): RowValue => ({
  kind: 'unresolved',
  code: codeOf(node),
  reason,
});

const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/;

/** JS-like text of a value; the row fingerprint hashes it, so unresolved reasons stay out. */
export function renderRowValue(value: RowValue): string {
  switch (value.kind) {
    case 'string':
      return JSON.stringify(value.value);
    case 'number':
      return value.text;
    case 'bigint':
      return `${value.text}n`;
    case 'boolean':
      return String(value.value);
    case 'null':
    case 'undefined':
      return value.kind;
    case 'regexp':
      return `/${value.pattern}/${value.flags}`;
    case 'array':
      return `[${value.items.map(renderRowValue).join(', ')}]`;
    case 'object':
      return `{${value.entries
        .map(
          ({ key, value: v }) =>
            `${IDENTIFIER_KEY.test(key) ? key : JSON.stringify(key)}: ${renderRowValue(v)}`,
        )
        .join(', ')}}`;
    case 'unresolved':
      return `?(${value.code})`;
  }
}

/** Every unresolved reason inside a value, depth first. */
function unresolvedIn(value: RowValue): string[] {
  if (value.kind === 'unresolved') return [value.reason];
  if (value.kind === 'array') return value.items.flatMap(unresolvedIn);
  if (value.kind === 'object') return value.entries.flatMap((entry) => unresolvedIn(entry.value));
  return [];
}

/** JS `String(value)` of a primitive value, else null. */
function stringOf(value: RowValue): string | null {
  switch (value.kind) {
    case 'string':
      return value.value;
    case 'number':
      return String(Number(value.text));
    case 'bigint':
      return value.text;
    case 'boolean':
      return String(value.value);
    case 'null':
    case 'undefined':
      return value.kind;
    default:
      return null;
  }
}

/** JS truthiness of a primitive value, else null. */
function truthy(value: RowValue): boolean | null {
  switch (value.kind) {
    case 'string':
      return value.value !== '';
    case 'number': {
      const n = Number(value.text);
      return n !== 0 && !Number.isNaN(n);
    }
    case 'bigint':
      return value.text !== '0';
    case 'boolean':
      return value.value;
    case 'null':
    case 'undefined':
      return false;
    case 'regexp':
    case 'array':
    case 'object':
      return true;
    default:
      return null;
  }
}

/** Object entries with JS semantics: a repeated key keeps its first position, last value. */
function objectValue(entries: readonly RowEntry[]): RowValue {
  const byKey = new Map<string, RowValue>();
  for (const { key, value } of entries) byKey.set(key, value);
  return { kind: 'object', entries: [...byKey].map(([key, value]) => ({ key, value })) };
}

// ── Static evaluation ──────────────────────────────────────────────────────

/** Looks through TypeScript-only wrappers and parentheses. */
function unwrap(input: AnyPath): AnyPath {
  let current = input;
  while (
    current.isTSAsExpression() ||
    current.isTSSatisfiesExpression() ||
    current.isTSNonNullExpression() ||
    current.isTSTypeAssertion() ||
    current.isParenthesizedExpression()
  ) {
    current = current.get('expression');
  }
  return current;
}

/** `it.each`, `test.for`, `describe.each` … as a callee or template tag. */
const isTableTag = (callee: t.Node): boolean =>
  t.isMemberExpression(callee) &&
  !callee.computed &&
  t.isIdentifier(callee.property) &&
  TABLE_MODIFIERS.has(callee.property.name) &&
  TABLE_CALL_ROOTS.has(shapeOf(callee)?.root ?? '');
const isTableCall = (call: t.CallExpression): boolean => isTableTag(call.callee);

const purity = new WeakMap<Binding, boolean>();

/** Whether a `const` binding's array or object value can never change (module docs). */
function isPure(binding: Binding): boolean {
  const known = purity.get(binding);
  if (known !== undefined) return known;
  purity.set(binding, false); // a cycle stays impure
  const declaration = binding.path.parentPath;
  const exported = declaration?.parentPath?.isExportNamedDeclaration() ?? false;
  const pure =
    !exported &&
    binding.constantViolations.length === 0 &&
    binding.referencePaths.every((reference) => isPureReference(reference));
  purity.set(binding, pure);
  return pure;
}

/** Whether one reference to a table binding only reads it (see {@link isPure}). */
function isPureReference(reference: AnyPath): boolean {
  let child = reference;
  for (;;) {
    const parent = child.parentPath;
    if (parent === null) return false;
    const key = child.key;
    if (
      parent.isArrayExpression() ||
      parent.isSpreadElement() ||
      parent.isObjectExpression() ||
      (parent.isObjectProperty() && key === 'value') ||
      ((parent.isTSAsExpression() ||
        parent.isTSSatisfiesExpression() ||
        parent.isTSNonNullExpression() ||
        parent.isTSTypeAssertion() ||
        parent.isParenthesizedExpression()) &&
        key === 'expression')
    ) {
      child = parent;
      continue;
    }
    if (parent.isTSTypeQuery() || parent.isBinaryExpression()) return true;
    if (parent.isTemplateLiteral()) {
      // A tag receives the value itself; only a table tag (`it.each\`…\``) is a known reader.
      const tagged = parent.parentPath;
      return !tagged.isTaggedTemplateExpression() || isTableTag(tagged.node.tag);
    }
    if (parent.isUnaryExpression()) return parent.node.operator !== 'delete';
    if (parent.isMemberExpression() && key === 'object') {
      const property = parent.node.property;
      if (parent.node.computed || !t.isIdentifier(property)) return false;
      const grand = parent.parentPath;
      const written =
        (grand.isAssignmentExpression() && parent.key === 'left') || grand.isUpdateExpression();
      if (property.name === 'length') return !written;
      const called = grand.isCallExpression() && parent.key === 'callee';
      if (called && PRIMITIVE_READS.has(property.name)) return true;
      if (called && property.name === 'slice') {
        child = grand; // a copy: its own flow decides
        continue;
      }
      return false;
    }
    if (parent.isCallExpression() && child.listKey === 'arguments') {
      if (key === 0 && isTableCall(parent.node)) return true;
      return key === 0 && t.isIdentifier(parent.node.callee, { name: 'expect' });
    }
    if (parent.isForOfStatement()) return key === 'right';
    if (parent.isVariableDeclarator() && key === 'init' && t.isIdentifier(parent.node.id)) {
      const alias = parent.scope.getBinding(parent.node.id.name);
      return alias !== undefined && alias.kind === 'const' && isPure(alias);
    }
    return false;
  }
}

type Resolved = { init: AnyPath; binding: Binding } | { reason: string };

/** The initialiser path of a plain `const` an identifier refers to. */
function resolveConst(identifier: NodePath<t.Identifier>): Resolved {
  const name = identifier.node.name;
  const binding = identifier.scope.getBinding(name);
  if (binding === undefined) return { reason: `${name} is not declared in the file` };
  if (binding.kind === 'module') return { reason: `${name} is imported` };
  const declarator = binding.path;
  if (binding.kind !== 'const' || !declarator.isVariableDeclarator()) {
    return { reason: `${name} is not a const` };
  }
  const init = declarator.get('init');
  if (!t.isIdentifier(declarator.node.id) || init.node === null) {
    return { reason: `${name} is not a plain const` };
  }
  return { init, binding };
}

/** The static value of an expression; unknown parts come back as `unresolved` values. */
export function evaluateValue(input: AnyPath, depth = 0): RowValue {
  const p = unwrap(input);
  const node = p.node;
  if (t.isStringLiteral(node)) return { kind: 'string', value: node.value };
  if (t.isNumericLiteral(node)) return numberValue(node.value);
  if (t.isBooleanLiteral(node)) return { kind: 'boolean', value: node.value };
  if (t.isNullLiteral(node)) return { kind: 'null' };
  if (t.isBigIntLiteral(node)) return { kind: 'bigint', text: String(node.value) };
  if (t.isRegExpLiteral(node)) return { kind: 'regexp', pattern: node.pattern, flags: node.flags };
  if (p.isTemplateLiteral()) {
    let text = '';
    const expressions = p.get('expressions');
    for (const [index, quasi] of p.node.quasis.entries()) {
      if (quasi.value.cooked == null) return unresolvedValue(node, 'invalid template escape');
      text += quasi.value.cooked;
      const expression = expressions[index];
      if (expression === undefined) continue;
      const part = stringOf(evaluateValue(expression, depth));
      if (part === null) return unresolvedValue(node, `not static: ${codeOf(node)}`);
      text += part;
    }
    return { kind: 'string', value: text };
  }
  if (p.isIdentifier()) return evaluateIdentifier(p, depth);
  if (p.isUnaryExpression()) return evaluateUnary(p, depth);
  if (p.isBinaryExpression()) return evaluateBinary(p, depth);
  if (p.isMemberExpression()) return evaluateMember(p, depth);
  if (p.isArrayExpression()) {
    const items: RowValue[] = [];
    for (const element of p.get('elements')) {
      if (element.node === null) return unresolvedValue(node, 'array hole');
      if (element.isSpreadElement()) {
        const spread = evaluateValue(element.get('argument'), depth);
        if (spread.kind !== 'array') {
          return unresolvedValue(node, `spread of a non-static value: ${codeOf(element.node)}`);
        }
        items.push(...spread.items);
      } else items.push(evaluateValue(element, depth));
    }
    return { kind: 'array', items };
  }
  if (p.isObjectExpression()) return evaluateObject(p, depth);
  if (p.isCallExpression()) {
    const sliced = evaluateSlice(p, depth);
    if (sliced !== null) return sliced;
  }
  return unresolvedValue(node, `not static: ${codeOf(node)}`);
}

function evaluateIdentifier(p: NodePath<t.Identifier>, depth: number): RowValue {
  const name = p.node.name;
  if (p.scope.getBinding(name) === undefined) {
    if (name === 'undefined') return UNDEFINED;
    if (name === 'NaN') return numberValue(Number.NaN);
    if (name === 'Infinity') return numberValue(Number.POSITIVE_INFINITY);
  }
  const resolved = resolveConst(p);
  if ('reason' in resolved) return unresolvedValue(p.node, resolved.reason);
  if (depth >= MAX_DEPTH) return unresolvedValue(p.node, `${name} nests too deep`);
  const value = evaluateValue(resolved.init, depth + 1);
  if ((value.kind === 'array' || value.kind === 'object') && !isPure(resolved.binding)) {
    return unresolvedValue(p.node, `${name} may be mutated`);
  }
  return value;
}

function evaluateUnary(p: NodePath<t.UnaryExpression>, depth: number): RowValue {
  const { operator } = p.node;
  if (operator === 'void') return UNDEFINED;
  const argument = evaluateValue(p.get('argument'), depth);
  if (operator === '!') {
    const value = truthy(argument);
    return value === null
      ? unresolvedValue(p.node, 'not static')
      : { kind: 'boolean', value: !value };
  }
  if (argument.kind === 'number' && (operator === '-' || operator === '+' || operator === '~')) {
    const n = Number(argument.text);
    return numberValue(operator === '-' ? -n : operator === '+' ? n : ~n);
  }
  if (argument.kind === 'bigint' && operator === '-') {
    return { kind: 'bigint', text: String(-BigInt(argument.text)) };
  }
  return unresolvedValue(p.node, `not static: ${codeOf(p.node)}`);
}

const NUMBER_OPERATORS: Readonly<Record<string, (a: number, b: number) => number>> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => a % b,
  '**': (a, b) => a ** b,
  '|': (a, b) => a | b,
  '&': (a, b) => a & b,
  '^': (a, b) => a ^ b,
  '<<': (a, b) => a << b,
  '>>': (a, b) => a >> b,
  '>>>': (a, b) => a >>> b,
};

function evaluateBinary(p: NodePath<t.BinaryExpression>, depth: number): RowValue {
  const left = p.get('left');
  if (!left.isExpression()) return unresolvedValue(p.node, 'not static');
  const a = evaluateValue(left, depth);
  const b = evaluateValue(p.get('right'), depth);
  const { operator } = p.node;
  if (operator === '+' && (a.kind === 'string' || b.kind === 'string')) {
    const x = stringOf(a);
    const y = stringOf(b);
    if (x !== null && y !== null) return { kind: 'string', value: x + y };
  }
  const apply = NUMBER_OPERATORS[operator];
  if (apply !== undefined && a.kind === 'number' && b.kind === 'number') {
    return numberValue(apply(Number(a.text), Number(b.text)));
  }
  return unresolvedValue(p.node, `not static: ${codeOf(p.node)}`);
}

function evaluateMember(p: NodePath<t.MemberExpression>, depth: number): RowValue {
  const { object, property, computed } = p.node;
  if (!computed && t.isIdentifier(property)) {
    if (t.isIdentifier(object, { name: 'Number' }) && p.scope.getBinding('Number') === undefined) {
      const constant = NUMBER_CONSTANTS.get(property.name);
      if (constant !== undefined) return numberValue(constant);
    }
    if (property.name === 'length') {
      const base = evaluateValue(p.get('object'), depth);
      if (base.kind === 'string') return numberValue(base.value.length);
      if (base.kind === 'array') return numberValue(base.items.length);
    }
  }
  return unresolvedValue(p.node, `not static: ${codeOf(p.node)}`);
}

function evaluateObject(p: NodePath<t.ObjectExpression>, depth: number): RowValue {
  const entries: RowEntry[] = [];
  for (const property of p.get('properties')) {
    if (property.isSpreadElement()) {
      const spread = evaluateValue(property.get('argument'), depth);
      if (spread.kind !== 'object') return unresolvedValue(p.node, 'spread of a non-static object');
      entries.push(...spread.entries);
      continue;
    }
    if (!property.isObjectProperty()) return unresolvedValue(p.node, 'object method');
    const keyNode = property.node.key;
    let key: string | null = null;
    if (!property.node.computed && t.isIdentifier(keyNode)) key = keyNode.name;
    else if (t.isStringLiteral(keyNode)) key = keyNode.value;
    else if (t.isNumericLiteral(keyNode)) key = String(keyNode.value);
    else {
      const keyPath = property.get('key');
      key = keyPath.isExpression() ? stringOf(evaluateValue(keyPath, depth)) : null;
    }
    if (key === null) return unresolvedValue(p.node, 'computed key');
    const value = property.get('value');
    entries.push({
      key,
      value: value.isExpression()
        ? evaluateValue(value, depth)
        : unresolvedValue(value.node, 'pattern'),
    });
  }
  return objectValue(entries);
}

/** `x.slice(a, b)` over a static array or string with numeric arguments, else null. */
function evaluateSlice(p: NodePath<t.CallExpression>, depth: number): RowValue | null {
  const callee = p.get('callee');
  if (!callee.isMemberExpression() || callee.node.computed) return null;
  if (!t.isIdentifier(callee.node.property, { name: 'slice' })) return null;
  const bounds = sliceBounds(p, depth);
  if (bounds === null) return null;
  const base = evaluateValue(callee.get('object'), depth);
  if (base.kind === 'array') return { kind: 'array', items: base.items.slice(...bounds) };
  if (base.kind === 'string') return { kind: 'string', value: base.value.slice(...bounds) };
  return null;
}

function sliceBounds(p: NodePath<t.CallExpression>, depth: number): number[] | null {
  const args = p.get('arguments');
  if (args.length > 2) return null;
  const bounds: number[] = [];
  for (const arg of args) {
    if (!arg.isExpression()) return null;
    const value = evaluateValue(arg, depth);
    if (value.kind !== 'number') return null;
    bounds.push(Number(value.text));
  }
  return bounds;
}

// ── Tables ─────────────────────────────────────────────────────────────────

interface TableRow {
  value: RowValue;
  node: t.Node | null;
}
type Table = { rows: TableRow[]; template: boolean } | { reason: string };

/** The rows of a table or loop source, with their nodes; a non-static row count is a reason. */
function tableRows(input: AnyPath, depth = 0): Table {
  const p = unwrap(input);
  if (p.isArrayExpression()) {
    const rows: TableRow[] = [];
    for (const element of p.get('elements')) {
      if (element.node === null) return { reason: 'array hole' };
      if (element.isSpreadElement()) {
        const spread = tableRows(element.get('argument'), depth);
        if ('reason' in spread) {
          return { reason: `spread of a non-static value: ${codeOf(element.node)}` };
        }
        rows.push(...spread.rows);
      } else rows.push({ value: evaluateValue(element, depth), node: element.node });
    }
    return { rows, template: false };
  }
  if (p.isIdentifier()) {
    const resolved = resolveConst(p);
    if ('reason' in resolved) return { reason: resolved.reason };
    if (depth >= MAX_DEPTH) return { reason: `${p.node.name} nests too deep` };
    const table = tableRows(resolved.init, depth + 1);
    if ('rows' in table && !isPure(resolved.binding)) {
      return { reason: `${p.node.name} may be mutated` };
    }
    return table;
  }
  if (p.isCallExpression()) {
    const callee = p.get('callee');
    const bounds = sliceBounds(p, depth);
    if (
      bounds !== null &&
      callee.isMemberExpression() &&
      !callee.node.computed &&
      t.isIdentifier(callee.node.property, { name: 'slice' })
    ) {
      const base = tableRows(callee.get('object'), depth);
      return 'rows' in base ? { rows: base.rows.slice(...bounds), template: false } : base;
    }
  }
  if (p.isTemplateLiteral() && p.parentPath.isTaggedTemplateExpression()) {
    return templateRows(p, depth);
  }
  return { reason: `not static: ${codeOf(p.node)}` };
}

/** A tagged-template table, read as Vitest 5's `formatTemplateString` reads it. */
function templateRows(p: NodePath<t.TemplateLiteral>, depth: number): Table {
  const cooked = p.node.quasis.map((quasi) => quasi.value.cooked);
  if (cooked.some((text) => text == null)) return { reason: 'invalid template escape' };
  const strings = cooked.map((text) => text ?? '');
  const cells = p.get('expressions').map((cell) => evaluateValue(cell, depth));
  if (cells.length === 0) {
    const rows = strings.map(
      (text): TableRow => ({ value: { kind: 'string', value: text }, node: null }),
    );
    return { rows, template: false };
  }
  const header = strings.join('').trim().replace(/ /g, '').split('\n')[0].split('|');
  const rows: TableRow[] = [];
  for (let row = 0; row < Math.floor(cells.length / header.length); row++) {
    const entries = header.map((key, column) => ({
      key,
      value: cells[row * header.length + column],
    }));
    rows.push({ value: objectValue(entries), node: null });
  }
  return { rows, template: true };
}

/** The callback arguments of each row (Vitest 5 `each` / `for` semantics). */
function rowArgs(rows: readonly TableRow[], kind: 'each' | 'for'): (RowValue[] | null)[] {
  if (kind === 'for') return rows.map((row) => [row.value]);
  const allArrays = rows.every((row) => row.value.kind === 'array');
  const someScalar = rows.some(
    (row) => row.value.kind !== 'array' && row.value.kind !== 'unresolved',
  );
  return rows.map((row) => {
    if (allArrays && row.value.kind === 'array') return row.value.items;
    return someScalar ? [row.value] : null;
  });
}

// ── Call sites ─────────────────────────────────────────────────────────────

interface Dimension {
  kind: DimensionKind;
  rows: TableRow[];
  args: (RowValue[] | null)[];
}

type Expansion =
  | { dimensions: Dimension[]; suiteTitles: t.Node[]; eachSuite: boolean }
  | { reason: string };

/** The node path of `node` inside `root`'s subtree, else null. */
function pathOf(root: AnyPath, node: t.Node): AnyPath | null {
  if (root.node === node) return root;
  let found: AnyPath | null = null;
  root.traverse({
    enter(p) {
      if (p.node === node) {
        found = p;
        p.stop();
      }
    },
  });
  return found;
}

/** A table dimension for an `each`/`for` table node under `calleePath`, or a reason. */
function tableDimension(
  calleePath: AnyPath,
  table: t.Node,
  kinds: { each: DimensionKind; for: DimensionKind },
  useFor: boolean,
): Dimension | { reason: string } {
  const tablePath = pathOf(calleePath, table);
  if (tablePath === null) return { reason: 'table not found' };
  const rows = tableRows(tablePath);
  if ('reason' in rows) return rows;
  return {
    kind: useFor ? kinds.for : kinds.each,
    rows: rows.rows,
    args: rowArgs(rows.rows, useFor || rows.template ? 'for' : 'each'),
  };
}

/** Enclosing constructs that repeat the call, outermost first, or why their count is unknown. */
function enclosing(callPath: AnyPath): Expansion {
  const chain: AnyPath[] = [];
  for (let p: AnyPath | null = callPath; p !== null; p = p.parentPath) chain.unshift(p);
  const dimensions: Dimension[] = [];
  const suiteTitles: t.Node[] = [];
  let eachSuite = false;
  for (let i = 0; i < chain.length - 1; i++) {
    const p = chain[i];
    const child = chain[i + 1];
    if (p.isFunction()) {
      const host = p.parentPath;
      if (
        host === null ||
        !host.isCallExpression() ||
        p.listKey !== 'arguments' ||
        roleOf(host.node, shapeOf(host.node.callee)) !== 'suite'
      ) {
        return { reason: 'nested-function' };
      }
      const title = host.node.arguments[0];
      if (title !== undefined) suiteTitles.push(title);
      const table = eachTableOf(host.node.callee);
      if (table === null) continue;
      eachSuite = true;
      const useFor = shapeOf(host.node.callee)?.mods.includes('for') ?? false;
      const dimension = tableDimension(
        host.get('callee'),
        table,
        { each: 'describe-each', for: 'describe-for' },
        useFor,
      );
      if ('reason' in dimension) {
        return { reason: `${useFor ? 'describe-for' : 'describe-each'}: ${dimension.reason}` };
      }
      dimensions.push(dimension);
    } else if (p.isForOfStatement()) {
      if (child.key === 'right') continue;
      if (p.node.await) return { reason: 'loop: for await' };
      if (child.key !== 'body') return { reason: `loop: ${p.node.type}` };
      const rows = tableRows(p.get('right'));
      if ('reason' in rows) return { reason: `for-of: ${rows.reason}` };
      dimensions.push({
        kind: 'for-of',
        rows: rows.rows,
        args: rows.rows.map((row) => [row.value]),
      });
    } else if (p.isLoop()) {
      return { reason: `loop: ${p.node.type}` };
    } else if (p.isClass()) {
      return { reason: 'class' };
    }
  }
  return { dimensions, suiteTitles, eachSuite };
}

/** Plain-string title text, else null. */
function plainTitle(node: t.Node | undefined): string | null {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** V8's position of the call, as Vitest reports it (1-based column). */
function callLocation(call: t.CallExpression, source: string): TestLocation {
  const callee = call.callee;
  const at = (loc: t.SourceLocation['start'] | undefined): TestLocation => ({
    line: loc?.line ?? 0,
    column: (loc?.column ?? 0) + 1,
  });
  if (t.isIdentifier(callee)) return at(callee.loc?.start);
  if (t.isMemberExpression(callee)) return at(callee.property.loc?.start);
  // The callee is itself a call (`it.each(t)(…)`): V8 points at this call's `(`.
  const before = call.typeArguments ?? callee;
  let index = before.end ?? 0;
  let line = before.loc?.end.line ?? 0;
  let column = before.loc?.end.column ?? 0;
  const advance = (): void => {
    if (source[index] === '\n') {
      line++;
      column = 0;
    } else column++;
    index++;
  };
  while (index < source.length && source[index] !== '(') {
    if (source.startsWith('//', index)) {
      while (index < source.length && source[index] !== '\n') advance();
    } else if (source.startsWith('/*', index)) {
      advance();
      advance();
      while (index < source.length && !source.startsWith('*/', index)) advance();
      advance();
      advance();
    } else if (/\s/.test(source[index])) advance();
    else break;
  }
  return { line, column: column + 1 };
}

/** Cartesian product of the dimensions' rows, outermost varying slowest. */
function instancesOf(dimensions: readonly Dimension[], ownTable: boolean): StaticInstance[] {
  const indexes: number[][] = [[]];
  for (const dimension of dimensions) {
    const next: number[][] = [];
    for (const prefix of indexes) {
      for (let row = 0; row < dimension.rows.length; row++) next.push([...prefix, row]);
    }
    indexes.splice(0, indexes.length, ...next);
  }
  return indexes.map((combination, row): StaticInstance => {
    const bound = combination.map(
      (index, d): InstanceDimension => ({
        kind: dimensions[d].kind,
        index,
        row: dimensions[d].rows[index].value,
        args: dimensions[d].args[index],
        node: dimensions[d].rows[index].node,
      }),
    );
    const unresolved = new Set<string>();
    for (const dimension of bound) {
      for (const reason of unresolvedIn(dimension.row))
        unresolved.add(`${dimension.kind}: ${reason}`);
      if (dimension.args === null) unresolved.add('each-row-shape');
    }
    const own = ownTable ? bound[bound.length - 1] : undefined;
    return {
      row,
      dimensions: bound,
      args: own === undefined ? [] : own.args,
      unresolved: [...unresolved].sort(),
      rowFingerprint: sha1(bound.map((d) => `${d.kind}:${renderRowValue(d.row)}`).join('\n')),
    };
  });
}

/** A call site whose number of instances is not static. */
const unknownSite = (record: CaseRecord, source: string, reason: string): StaticCallSite => ({
  file: toPackagePath(record.file),
  record,
  location: callLocation(record.call, source),
  fullName: null,
  instances: null,
  unresolved: [reason],
});

function expandSite(record: CaseRecord, callPath: AnyPath, source: string): StaticCallSite {
  const unknown = (reason: string): StaticCallSite => unknownSite(record, source, reason);
  const outer = enclosing(callPath);
  if ('reason' in outer) return unknown(outer.reason);
  const dimensions = [...outer.dimensions];
  if (record.each !== null) {
    const useFor = shapeOf(record.call.callee)?.mods.includes('for') ?? false;
    const own = tableDimension(
      callPath.get('callee'),
      record.each,
      { each: 'each', for: 'for' },
      useFor,
    );
    if ('reason' in own) return unknown(`each-table: ${own.reason}`);
    dimensions.push(own);
  }
  const count = dimensions.reduce((product, dimension) => product * dimension.rows.length, 1);
  if (count > MAX_INSTANCES) return unknown(`too many instances: ${count}`);
  const titles = [...outer.suiteTitles, record.call.arguments[0]].map(plainTitle);
  const fullName =
    outer.eachSuite || record.each !== null || titles.some((title) => title === null)
      ? null
      : titles.join(' > ');
  return {
    file: toPackagePath(record.file),
    record,
    location: callLocation(record.call, source),
    fullName,
    instances: instancesOf(dimensions, record.each !== null),
    unresolved: [],
  };
}

/** Node paths of the given call nodes in one AST. */
function callPaths(ast: t.File, calls: ReadonlySet<t.Node>): Map<t.Node, AnyPath> {
  const found = new Map<t.Node, AnyPath>();
  traverse(ast, {
    CallExpression(p) {
      if (calls.has(p.node)) found.set(p.node, p);
    },
  });
  return found;
}

/**
 * Expands the test calls of `files` (repo paths) into call sites with instances. Only files in
 * `tests` (repo paths; default every file) give records; the others only resolve constants for
 * Layer 0's context hash. Sites come per file in the order given, then in walk order.
 */
export function expandCases(
  files: readonly SourceFile[],
  tests: ReadonlySet<string> = new Set(files.map((file) => file.path)),
): StaticInventory {
  const corpus = extract([...files], { isTest: (file) => tests.has(file) });
  const byFile = new Map<string, CaseRecord[]>();
  for (const record of corpus.records) {
    const list = byFile.get(record.file) ?? [];
    list.push(record);
    byFile.set(record.file, list);
  }
  const sites: StaticCallSite[] = [];
  for (const { path: file, source } of files) {
    const records = byFile.get(file);
    const ast = corpus.asts.get(file);
    if (records === undefined || ast === undefined) continue;
    let paths: Map<t.Node, AnyPath> | string;
    try {
      paths = callPaths(ast, new Set(records.map((record) => record.call)));
    } catch (error) {
      // Babel's scope tracker throws on code that would not compile (a duplicate declaration).
      paths = `scope analysis failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    for (const record of records) {
      const callPath = typeof paths === 'string' ? undefined : paths.get(record.call);
      const failure = typeof paths === 'string' ? paths : 'call not found';
      sites.push(
        callPath === undefined
          ? unknownSite(record, source, failure)
          : expandSite(record, callPath, source),
      );
    }
  }
  return {
    sites,
    skipped: corpus.skipped.filter((file) => tests.has(file)).map(toPackagePath),
  };
}

/** Reads `packageFiles` (package paths) under `repoRoot` and expands them. */
export function loadStaticInventory(
  repoRoot: string,
  packageFiles: readonly string[],
): StaticInventory {
  const files = packageFiles.map((file): SourceFile => {
    const repoPath = fromPackagePath(file);
    return { path: repoPath, source: readFileSync(path.join(repoRoot, repoPath), 'utf8') };
  });
  return expandCases(files);
}
