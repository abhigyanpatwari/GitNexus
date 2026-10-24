/**
 * Checks of a test instance for the scenario map (Layer 2, U5, R5, KTD6, design §2 "Checks").
 *
 * A check is the shape of one `expect(subject)[.not|.resolves|.rejects].matcher(args)` of the test
 * body (also `expect.soft(…)`, `expect.assertions(n)`, `expect.hasAssertions()`), in source order:
 *  - literals become their kind: `<string>`, `<number>`, `<bigint>`, `<regexp>`. `true`, `false`,
 *    `null` and `undefined` stay, as do object keys. Expected values are not lost: the input facet
 *    (U6, design §5.3 rule 3) keeps them;
 *  - selector literals in the subject stay exact (design §2, §5.3 rule 4): the literal arguments of
 *    a subject call that also takes a non-literal operand (another argument, or a receiver that is
 *    a value rather than a global or a module namespace), as in `getNodesByLabel(r, 'Function')` or
 *    `graph.get('x')`, and a literal computed key such as `nodes[0]`. A call over literals only,
 *    such as `fn('a')` or `toMillis(2, 's')`, has inputs, not selectors;
 *  - names declared in the test body become `<v1>`, `<v2>` … in order of first use, so renamed
 *    locals match; imported, file-level and global names stay;
 *  - per instance (R5): names bound by the test's own `each`/`for` row and by the innermost
 *    `for…of` element take the instance's values from the static inventory (U3). They are
 *    abstracted like literals, and exact in selector positions;
 *  - snapshot matchers carry the sha1 of the snapshot: the inline text (common indentation
 *    stripped), the `.snap` entry (key `<full name>[ > <hint>] <n>`, counted per name as Vitest
 *    does) or the `toMatchFileSnapshot` file, both read through a {@link SnapshotReader}.
 *
 * SUPPORTED_MATCHERS, Vitest 5's Jest-style matchers:
 *   toBe toEqual toStrictEqual toMatchObject toBeTruthy toBeFalsy toBeNull toBeUndefined
 *   toBeDefined toBeNaN toBeNullable toBeTypeOf toBeInstanceOf toBeGreaterThan
 *   toBeGreaterThanOrEqual toBeLessThan toBeLessThanOrEqual toBeCloseTo toBeOneOf toContain
 *   toContainEqual toHaveLength toHaveProperty toMatch toThrow toThrowError toHaveBeenCalled
 *   toHaveBeenCalledOnce toHaveBeenCalledTimes toHaveBeenCalledWith
 *   toHaveBeenCalledExactlyOnceWith toHaveBeenLastCalledWith toHaveBeenNthCalledWith
 *   toHaveBeenCalledBefore toHaveBeenCalledAfter toBeCalled toBeCalledTimes toBeCalledWith
 *   toHaveReturned toHaveReturnedTimes toHaveReturnedWith toHaveLastReturnedWith
 *   toHaveNthReturnedWith toReturn toReturnTimes toReturnWith toHaveResolved toHaveResolvedTimes
 *   toHaveResolvedWith toHaveLastResolvedWith toHaveNthResolvedWith, and the snapshot matchers
 *   toMatchSnapshot toMatchInlineSnapshot toMatchFileSnapshot toThrowErrorMatchingSnapshot
 *   toThrowErrorMatchingInlineSnapshot.
 *
 * Anything else is unsupported, with the form named (design §2): `assert.*` and node:assert
 * functions, `expectTypeOf`/`assertType`, chai-style chains (`expect(x).to.equal`, `.should`),
 * custom matchers, `toSatisfy` (an arbitrary predicate), other `expect.*` forms (`expect.poll` …);
 * an `expect` inside a loop, a conditional, a catch clause or a nested function of the body, where
 * data decides how many checks run; an `expect` inside a helper the body calls: a file-level
 * declaration, or a function imported from a test-support module (read through a
 * {@link ModuleReader}; one that cannot be read is unsupported as not inspected); a snapshot whose
 * text cannot be read. A selector whose instance value is not static is `unresolved`. Both block
 * strong evidence.
 *
 * The fingerprint is sha1 over the checks and the unsupported forms in source order.
 * {@link checksContextKey} joins it with the context hash (./context.ts): Layer 1's second
 * candidate source (KTD5).
 *
 * Library only; the scenario-map CLI (U14) calls {@link computeChecks} per inventory instance,
 * with {@link fsSnapshotReader} and {@link fsModuleReader} over the repo root.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generate } from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import {
  extract,
  isTestSupportFile,
  resolveName,
  shapeOf,
  type CaseRecord,
  type Decl,
  type Frame,
  type SourceFile,
} from '../../test-dupes/test-dupes.js';
import {
  normalizeRelativePath,
  type InventoryInstance,
  type RowEntry,
  type RowValue,
  type StaticInstance,
} from '../types.js';
import { contextOf } from './context.js';

const SNAPSHOT_MATCHERS: ReadonlySet<string> = new Set([
  'toMatchSnapshot',
  'toMatchInlineSnapshot',
  'toMatchFileSnapshot',
  'toThrowErrorMatchingSnapshot',
  'toThrowErrorMatchingInlineSnapshot',
]);

/** The matchers a check may use; see the module header. */
export const SUPPORTED_MATCHERS: ReadonlySet<string> = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toMatchObject',
  'toBeTruthy',
  'toBeFalsy',
  'toBeNull',
  'toBeUndefined',
  'toBeDefined',
  'toBeNaN',
  'toBeNullable',
  'toBeTypeOf',
  'toBeInstanceOf',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeCloseTo',
  'toBeOneOf',
  'toContain',
  'toContainEqual',
  'toHaveLength',
  'toHaveProperty',
  'toMatch',
  'toThrow',
  'toThrowError',
  'toHaveBeenCalled',
  'toHaveBeenCalledOnce',
  'toHaveBeenCalledTimes',
  'toHaveBeenCalledWith',
  'toHaveBeenCalledExactlyOnceWith',
  'toHaveBeenLastCalledWith',
  'toHaveBeenNthCalledWith',
  'toHaveBeenCalledBefore',
  'toHaveBeenCalledAfter',
  'toBeCalled',
  'toBeCalledTimes',
  'toBeCalledWith',
  'toHaveReturned',
  'toHaveReturnedTimes',
  'toHaveReturnedWith',
  'toHaveLastReturnedWith',
  'toHaveNthReturnedWith',
  'toReturn',
  'toReturnTimes',
  'toReturnWith',
  'toHaveResolved',
  'toHaveResolvedTimes',
  'toHaveResolvedWith',
  'toHaveLastResolvedWith',
  'toHaveNthResolvedWith',
  ...SNAPSHOT_MATCHERS,
]);

/** Chain members allowed between `expect(…)` and the matcher. */
const MODIFIERS: ReadonlySet<string> = new Set(['not', 'resolves', 'rejects']);
/** `expect.<name>(…)` calls that are checks on their own. */
const EXPECT_STATICS: ReadonlySet<string> = new Set(['assertions', 'hasAssertions']);
/** node:assert functions, recognised when the name resolves to no declaration of the file. */
const NODE_ASSERT: ReadonlySet<string> = new Set([
  'ok',
  'equal',
  'notEqual',
  'deepEqual',
  'notDeepEqual',
  'strictEqual',
  'notStrictEqual',
  'deepStrictEqual',
  'notDeepStrictEqual',
  'partialDeepStrictEqual',
  'throws',
  'doesNotThrow',
  'rejects',
  'doesNotReject',
  'match',
  'doesNotMatch',
  'fail',
  'ifError',
]);
const TYPE_ASSERTIONS: ReadonlySet<string> = new Set(['expectTypeOf', 'assertType']);
/** Names that are literals when not redeclared. */
const LITERAL_GLOBALS: ReadonlySet<string> = new Set(['undefined', 'NaN', 'Infinity']);
/** Globals a free name may be, rather than a binding of an enclosing table row. */
const GLOBALS: ReadonlySet<string> = new Set([
  ...LITERAL_GLOBALS,
  'globalThis',
  'Math',
  'JSON',
  'Object',
  'Array',
  'Number',
  'String',
  'Boolean',
  'Symbol',
  'BigInt',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Buffer',
  'process',
  'console',
  'URL',
  'URLSearchParams',
  'Intl',
  'Reflect',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'structuredClone',
  'setTimeout',
  'clearTimeout',
  'queueMicrotask',
  'TextEncoder',
  'TextDecoder',
  'expect',
  'vi',
  'require',
  '__dirname',
  '__filename',
]);
/** TS nodes that hold an expression; every other `TS*` node is a type and is kept as written. */
const TS_EXPRESSIONS: ReadonlySet<string> = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
]);
/** How many helper declarations deep an `expect` is looked for. */
const HELPER_DEPTH = 4;
const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/;
const UNDEFINED: RowValue = { kind: 'undefined' };

// ── Public shapes ──────────────────────────────────────────────────────────

export interface Check {
  /** 1-based line of the assertion. */
  line: number;
  /** `expect`, `expect.soft`, `expect.assertions` or `expect.hasAssertions`. */
  form: string;
  /** `not` / `resolves` / `rejects`, as written. */
  modifiers: string[];
  /** The matcher; `''` for `expect.assertions` / `expect.hasAssertions`. */
  matcher: string;
  /** The rendered shape, e.g. `expect(getNodesByLabel(<v1>,"Function")).toHaveLength(<number>)`. */
  shape: string;
  /** sha1 of the snapshot for snapshot matchers, else null. */
  snapshot: string | null;
}

export interface UnsupportedForm {
  /** 1-based line of the construct. */
  line: number;
  /** The construct: `assert.equal`, `expect(...).toBeFoo`, a helper's name … */
  form: string;
  /** Why it is unsupported: `not an expect assertion`, `inside a loop (ForStatement)` … */
  reason: string;
}

export interface InstanceChecks {
  checks: Check[];
  /** Empty when every assertion form is supported. Non-empty blocks strong evidence. */
  unsupported: UnsupportedForm[];
  /** Selectors whose instance value is not static, sorted. Non-empty blocks strong evidence. */
  unresolved: string[];
  /** sha1 over the checks' shapes and the unsupported forms, in source order. */
  fingerprint: string;
}

/** Snapshot text by test file (repo path). */
export interface SnapshotReader {
  /** The raw value of `key` in the test file's `__snapshots__/<name>.snap`, else null. */
  entry(testFile: string, key: string): string | null;
  /** The text of `snapshotPath`, relative to the test file's directory, else null. */
  file(testFile: string, snapshotPath: string): string | null;
}

/** Source of a helper module by Layer 0 module key (repo path without extension). */
export interface ModuleReader {
  read(moduleKey: string): SourceFile | null;
}

export interface ChecksOptions {
  /** Without one, file snapshots are unsupported (`snapshot file not read`). */
  snapshots?: SnapshotReader;
  /** Without one, calls to imported test-support helpers are unsupported (not inspected). */
  modules?: ModuleReader;
}

/** One test instance: the call site's record, its static instance and its Vitest full name. */
export interface CheckSubject {
  record: CaseRecord;
  /** null when the instance is not known (no one-to-one join, or a count that is not static). */
  instance: StaticInstance | null;
  /** Vitest full name, the key of file snapshots; null when not known. */
  fullName: string | null;
}

// ── Small helpers ──────────────────────────────────────────────────────────

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');
const gen = (node: t.Node): string => generate(node, { comments: false, compact: true }).code;
const lineOf = (node: t.Node): number => node.loc?.start.line ?? 0;
/** An identifier node with any text, for placeholders such as `<string>` (never parsed back). */
const rawIdentifier = (name: string): t.Identifier => Object.assign(t.identifier('x'), { name });
const keyNode = (key: string): t.Node =>
  IDENTIFIER_KEY.test(key) ? rawIdentifier(key) : t.stringLiteral(key);

const isNode = (value: unknown): value is t.Node =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string';

/** A copy of `node` with some children replaced; the original is never mutated. */
function withChildren<T extends t.Node>(node: T, children: Record<string, unknown>): T {
  return Object.assign(t.cloneNode(node, false), children);
}

/** The expression inside TS wrappers (`x as T`, `x!`, `<T>x`). */
function unwrap(node: t.Node): t.Node {
  let n = node;
  while (TS_EXPRESSIONS.has(n.type) || t.isParenthesizedExpression(n)) {
    n = (n as t.TSAsExpression).expression;
  }
  return n;
}

/** `a.b.c` for an identifier / non-computed member chain, else null. */
function dotted(node: t.Node): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
    const object = dotted(node.object);
    return object === null ? null : `${object}.${node.property.name}`;
  }
  return null;
}

/** The identifier a callee chain starts from (through members, calls and TS wrappers). */
function rootName(node: t.Node): string | null {
  let n = node;
  for (;;) {
    n = unwrap(n);
    if (t.isIdentifier(n)) return n.name;
    if (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) n = n.object;
    else if (t.isCallExpression(n) || t.isOptionalCallExpression(n)) n = n.callee;
    else return null;
  }
}

function memberKey(node: t.MemberExpression | t.OptionalMemberExpression): string | null {
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
  if (t.isStringLiteral(node.property)) return node.property.value;
  if (t.isNumericLiteral(node.property)) return String(node.property.value);
  return null;
}

/** The value of `key` in an object row (the last entry wins, as in JS), else `undefined`. */
function entryValue(entries: readonly RowEntry[], key: string): RowValue {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].key === key) return entries[i].value;
  return UNDEFINED;
}

function hasUnresolved(value: RowValue): boolean {
  if (value.kind === 'unresolved') return true;
  if (value.kind === 'array') return value.items.some(hasUnresolved);
  if (value.kind === 'object') return value.entries.some((entry) => hasUnresolved(entry.value));
  return false;
}

/** Text without the blank first and last lines and the common indentation Vitest writes. */
function stripIndentation(text: string): string {
  const lines = text.split('\n');
  const blank = (line: string | undefined): boolean => (line ?? '').trim() === '';
  if (lines.length < 3 || !blank(lines[0]) || !blank(lines[lines.length - 1])) return text;
  const body = lines.slice(1, -1);
  const indents = body.filter((line) => !blank(line)).map((line) => line.search(/\S/));
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return body.map((line) => (blank(line) ? '' : line.slice(indent))).join('\n');
}

// ── Instance scope: locals and row bindings ────────────────────────────────

interface Scope {
  record: CaseRecord;
  /** Names declared in the body (nested ones too) and own parameters no row binds. */
  locals: ReadonlySet<string>;
  /** Names bound by the instance's row; null when the value is not known. */
  rows: ReadonlyMap<string, RowValue | null>;
  /** Kinds of enclosing table dimensions whose bindings are not tracked. */
  unboundOuter: readonly string[];
  localIds: Map<string, string>;
  unresolved: Set<string>;
}

function addPattern(pattern: t.Node, into: Set<string>): void {
  for (const name of Object.keys(t.getBindingIdentifiers(pattern))) into.add(name);
}

function declaredNames(root: t.Node, into: Set<string>): void {
  t.traverseFast(root, (n) => {
    if (t.isVariableDeclarator(n)) addPattern(n.id, into);
    else if (t.isFunction(n)) {
      if ((t.isFunctionDeclaration(n) || t.isFunctionExpression(n)) && n.id) into.add(n.id.name);
      for (const param of n.params) addPattern(param, into);
    } else if ((t.isClassDeclaration(n) || t.isClassExpression(n)) && n.id) into.add(n.id.name);
    else if (t.isCatchClause(n) && n.param) addPattern(n.param, into);
  });
}

function objectKey(property: t.ObjectProperty): string | null {
  if (!property.computed && t.isIdentifier(property.key)) return property.key.name;
  if (t.isStringLiteral(property.key)) return property.key.value;
  return null;
}

/** Binds the names of `pattern` to `value` (null: bound, value unknown). */
function bindPattern(
  pattern: t.Node,
  value: RowValue | null,
  rows: Map<string, RowValue | null>,
): void {
  if (t.isIdentifier(pattern)) rows.set(pattern.name, value);
  else if (t.isAssignmentPattern(pattern)) {
    bindPattern(pattern.left, value !== null && value.kind !== 'undefined' ? value : null, rows);
  } else if (t.isArrayPattern(pattern)) {
    pattern.elements.forEach((element, index) => {
      if (element === null) return;
      const item = value?.kind === 'array' ? (value.items[index] ?? UNDEFINED) : null;
      bindPattern(element, item, rows);
    });
  } else if (t.isObjectPattern(pattern)) {
    for (const property of pattern.properties) {
      if (t.isRestElement(property)) {
        bindPattern(property.argument, null, rows);
        continue;
      }
      const key = objectKey(property);
      const entry =
        value?.kind === 'object' && key !== null ? entryValue(value.entries, key) : null;
      bindPattern(property.value, entry, rows);
    }
  } else if (t.isRestElement(pattern)) bindPattern(pattern.argument, null, rows);
}

function buildScope(subject: CheckSubject): Scope {
  const { record, instance } = subject;
  const locals = new Set<string>();
  const rows = new Map<string, RowValue | null>();
  declaredNames(record.fn.body, locals);

  // The test's own row: Vitest spreads an `each` row (instance.args holds the spread values) and
  // passes a `for` row whole; the remaining parameters (a test context) are locals.
  const params = record.fn.params;
  if (record.each === null) for (const param of params) addPattern(param, locals);
  else {
    const useFor = shapeOf(record.call.callee)?.mods.includes('for') ?? false;
    const args = instance?.args ?? null;
    const bound = args !== null ? args.length : useFor ? 1 : params.length;
    params.forEach((param, index) => {
      if (index >= bound) addPattern(param, locals);
      else bindPattern(param, args === null ? null : (args[index] ?? UNDEFINED), rows);
    });
  }

  // The innermost `for…of` element; outer loops and `describe.each` rows are not tracked.
  const dimensions = instance?.dimensions ?? [];
  const loop = record.loop;
  const boundLoop = loop !== null && t.isForOfStatement(loop);
  const lastForOf = dimensions.map((dimension) => dimension.kind).lastIndexOf('for-of');
  if (boundLoop) {
    const pattern = t.isVariableDeclaration(loop.left) ? loop.left.declarations[0]?.id : loop.left;
    const dimension = lastForOf >= 0 ? dimensions[lastForOf] : undefined;
    const value = dimension === undefined ? null : (dimension.args?.[0] ?? dimension.row);
    if (pattern !== undefined) bindPattern(pattern, value, rows);
  }
  const unboundOuter = dimensions
    .filter(
      (dimension, index) =>
        dimension.kind !== 'each' &&
        dimension.kind !== 'for' &&
        !(boundLoop && index === lastForOf),
    )
    .map((dimension) => dimension.kind);

  const unresolved = new Set<string>();
  for (const name of rows.keys()) {
    if (locals.has(name)) unresolved.add(`row binding ${name} is redeclared in the body`);
  }
  return { record, locals, rows, unboundOuter, localIds: new Map(), unresolved };
}

/** The row value an identifier or member read of a row binding evaluates to; null otherwise. */
function rowValueOf(node: t.Node, scope: Scope): RowValue | 'unknown' | null {
  const inner = unwrap(node);
  if (t.isIdentifier(inner)) {
    if (scope.locals.has(inner.name) || !scope.rows.has(inner.name)) return null;
    const value = scope.rows.get(inner.name) ?? null;
    return value === null || value.kind === 'unresolved' ? 'unknown' : value;
  }
  if (t.isMemberExpression(inner) || t.isOptionalMemberExpression(inner)) {
    const base = rowValueOf(inner.object, scope);
    if (base === null || base === 'unknown') return base;
    const key = memberKey(inner);
    if (key === null) return 'unknown';
    if (base.kind === 'object') return entryValue(base.entries, key);
    if (base.kind === 'array' && key === 'length') return numberValue(base.items.length);
    if (base.kind === 'array' && /^\d+$/.test(key)) return base.items[Number(key)] ?? UNDEFINED;
    if (base.kind === 'string' && key === 'length') return numberValue(base.value.length);
    return 'unknown';
  }
  return null;
}

const numberValue = (n: number): RowValue => ({ kind: 'number', text: String(n) });

// ── Shapes ─────────────────────────────────────────────────────────────────

function numberNode(text: string): t.Node {
  const value = Number(text);
  if (Number.isNaN(value)) return t.identifier('NaN');
  const magnitude = Math.abs(value);
  const core = Number.isFinite(magnitude) ? t.numericLiteral(magnitude) : t.identifier('Infinity');
  return text.startsWith('-') ? t.unaryExpression('-', core) : core;
}

/** A row value as code: exact, or with strings, numbers, bigints and regexps as their kind. */
function rowNode(value: RowValue, exact: boolean): t.Node {
  switch (value.kind) {
    case 'string':
      return exact ? t.stringLiteral(value.value) : rawIdentifier('<string>');
    case 'number':
      return exact ? numberNode(value.text) : rawIdentifier('<number>');
    case 'bigint':
      return exact ? t.bigIntLiteral(BigInt(value.text)) : rawIdentifier('<bigint>');
    case 'regexp':
      return exact ? t.regExpLiteral(value.pattern, value.flags) : rawIdentifier('<regexp>');
    case 'boolean':
      return t.booleanLiteral(value.value);
    case 'null':
      return t.nullLiteral();
    case 'undefined':
      return t.identifier('undefined');
    case 'array':
      return t.arrayExpression(value.items.map((item) => rowNode(item, exact) as t.Expression));
    case 'object':
      return t.objectExpression(
        value.entries.map((entry) =>
          t.objectProperty(
            keyNode(entry.key) as t.Expression,
            rowNode(entry.value, exact) as t.Expression,
          ),
        ),
      );
    case 'unresolved':
      return rawIdentifier('<unknown>');
  }
}

/** A literal node as code (exact, or as its kind); null for anything else. */
function literalNode(node: t.Node, exact: boolean): t.Node | null {
  if (t.isStringLiteral(node))
    return exact ? t.stringLiteral(node.value) : rawIdentifier('<string>');
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    const text = node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? '';
    return exact ? t.stringLiteral(text) : rawIdentifier('<string>');
  }
  if (t.isNumericLiteral(node))
    return exact ? t.numericLiteral(node.value) : rawIdentifier('<number>');
  if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) {
    return exact
      ? t.unaryExpression('-', t.numericLiteral(node.argument.value))
      : rawIdentifier('<number>');
  }
  if (t.isBigIntLiteral(node))
    return exact ? t.bigIntLiteral(node.value) : rawIdentifier('<bigint>');
  if (t.isRegExpLiteral(node)) {
    return exact ? t.regExpLiteral(node.pattern, node.flags) : rawIdentifier('<regexp>');
  }
  if (t.isBooleanLiteral(node)) return t.booleanLiteral(node.value);
  if (t.isNullLiteral(node)) return t.nullLiteral();
  return null;
}

/** A literal, a literal container, or a row value: data rather than a queried value. */
function isLiteralish(node: t.Node, scope: Scope): boolean {
  const inner = unwrap(node);
  if (literalNode(inner, false) !== null || rowValueOf(inner, scope) !== null) return true;
  if (t.isIdentifier(inner))
    return LITERAL_GLOBALS.has(inner.name) && !scope.locals.has(inner.name);
  if (t.isArrayExpression(inner)) {
    return inner.elements.every(
      (e) => e !== null && !t.isSpreadElement(e) && isLiteralish(e, scope),
    );
  }
  if (t.isObjectExpression(inner)) {
    return inner.properties.every(
      (p) => t.isObjectProperty(p) && !p.computed && isLiteralish(p.value, scope),
    );
  }
  return false;
}

/**
 * Whether a member call's receiver is a queried value: a local, a file-level declaration, a named
 * import or any computed value. A global (`Math`) or a module namespace / default import is a
 * function library, not a value the literal selects from.
 */
function receiverQueried(callee: t.Node, scope: Scope): boolean {
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return false;
  if (isLiteralish(callee.object, scope)) return false;
  let root = unwrap(callee.object);
  while (t.isMemberExpression(root) || t.isOptionalMemberExpression(root))
    root = unwrap(root.object);
  if (!t.isIdentifier(root)) return true;
  if (scope.locals.has(root.name)) return true;
  const decl = resolveName(root.name, scope.record.chain);
  if (decl === undefined) return false;
  return decl.kind === 'node' || !/#(\*|default)$/.test(decl.key);
}

function identifierNode(node: t.Identifier, scope: Scope): t.Node {
  const { name } = node;
  if (scope.locals.has(name)) {
    let id = scope.localIds.get(name);
    if (id === undefined) {
      id = `<v${scope.localIds.size + 1}>`;
      scope.localIds.set(name, id);
    }
    return rawIdentifier(id);
  }
  if (
    scope.unboundOuter.length > 0 &&
    !GLOBALS.has(name) &&
    resolveName(name, scope.record.chain) === undefined
  ) {
    scope.unresolved.add(
      `${name}: may be bound by an enclosing ${scope.unboundOuter.join(', ')} row`,
    );
  }
  return rawIdentifier(name);
}

/**
 * The abstracted copy of `node`. `inSubject` enables selectors; `exact` keeps the literals of this
 * node (a selector argument or a literal container inside one) as written.
 */
function abstractNode(node: t.Node, scope: Scope, inSubject: boolean, exact: boolean): t.Node {
  if (node.type.startsWith('TS') && !TS_EXPRESSIONS.has(node.type)) return node;
  const literal = literalNode(node, exact);
  if (literal !== null) return literal;
  const row = rowValueOf(node, scope);
  if (row !== null) {
    if (exact && (row === 'unknown' || hasUnresolved(row))) {
      scope.unresolved.add(`selector ${gen(node)}: instance value unknown`);
    }
    return row === 'unknown' ? rawIdentifier('<unknown>') : rowNode(row, exact);
  }
  const recurse = (child: t.Node, childExact = false): t.Node =>
    abstractNode(child, scope, inSubject, childExact);
  if (t.isIdentifier(node)) return identifierNode(node, scope);
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node) || t.isNewExpression(node)) {
    const queried =
      inSubject &&
      (node.arguments.some((arg) => !isLiteralish(arg, scope)) ||
        receiverQueried(node.callee, scope));
    return withChildren(node, {
      callee: recurse(node.callee),
      arguments: node.arguments.map((arg) => recurse(arg, queried)),
    });
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    return withChildren(node, {
      object: recurse(node.object),
      property: node.computed ? recurse(node.property, inSubject) : node.property,
    });
  }
  if (t.isArrayExpression(node)) {
    return withChildren(node, {
      elements: node.elements.map((element) => (element === null ? null : recurse(element, exact))),
    });
  }
  if (t.isObjectExpression(node)) {
    return withChildren(node, { properties: node.properties.map((p) => recurse(p, exact)) });
  }
  if (t.isObjectProperty(node)) {
    const key = node.computed
      ? recurse(node.key)
      : t.isIdentifier(node.key)
        ? keyNode(node.key.name)
        : t.isStringLiteral(node.key) || t.isNumericLiteral(node.key)
          ? keyNode(String(node.key.value))
          : node.key;
    return withChildren(node, { key, value: recurse(node.value, exact), shorthand: false });
  }
  if (TS_EXPRESSIONS.has(node.type)) {
    return withChildren(node, {
      expression: recurse((node as t.TSAsExpression).expression, exact),
    });
  }
  if (t.isTemplateLiteral(node)) {
    return withChildren(node, {
      quasis: exact
        ? node.quasis
        : node.quasis.map((quasi) => t.templateElement({ raw: '', cooked: '' }, quasi.tail)),
      expressions: node.expressions.map((expression) => recurse(expression)),
    });
  }
  if (t.isMetaProperty(node)) return node;
  const keepKey = (node as { computed?: unknown }).computed === false;
  const children: Record<string, unknown> = {};
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if ((keepKey && key === 'key') || key === 'label') continue;
    children[key] = Array.isArray(value)
      ? value.map((item) => (isNode(item) ? recurse(item) : item))
      : isNode(value)
        ? recurse(value)
        : value;
  }
  return withChildren(node, children);
}

// ── Assertions ─────────────────────────────────────────────────────────────

interface Assertion {
  /** `expect`, `expect.soft`, `expect.assertions`, `expect.hasAssertions`. */
  form: string;
  /** `expect(...).not.toBe` style name for reports. */
  display: string;
  subject: t.Node | null;
  message: t.Node | null;
  modifiers: string[];
  matcher: string;
  args: t.Node[];
}
interface Rejected {
  form: string;
  reason: string;
  matcher: string;
}

/** Splits an `expect` call into its parts, or names why the form is unsupported. */
function parseAssertion(call: t.CallExpression): Assertion | Rejected {
  const names: string[] = [];
  let n: t.Node = call.callee;
  while (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    names.unshift(n.property.name);
    n = n.object;
  }
  const matcher = names.at(-1) ?? '';
  if (t.isIdentifier(n, { name: 'expect' })) {
    if (names.length === 0) return { form: 'expect(...)', reason: 'no matcher', matcher };
    const form = `expect.${names.join('.')}`;
    if (names.length === 1 && EXPECT_STATICS.has(names[0])) {
      return {
        form,
        display: form,
        subject: null,
        message: null,
        modifiers: [],
        matcher: '',
        args: call.arguments,
      };
    }
    return { form, reason: 'not a supported expect form', matcher };
  }
  const chain = names.map((name) => `.${name}`).join('');
  if (!t.isCallExpression(n)) {
    return { form: `expect(...)${chain}`, reason: 'computed or indirect matcher', matcher };
  }
  const head = dotted(n.callee);
  if (head !== 'expect' && head !== 'expect.soft') {
    return head !== null && head.startsWith('expect.')
      ? { form: `${head}(...)`, reason: 'not a supported expect form', matcher }
      : { form: `expect(...)${chain}`, reason: 'chained form not supported', matcher };
  }
  const display = `${head}(...)${chain}`;
  const args = n.arguments;
  if (args.length < 1 || args.length > 2 || args.some((arg) => t.isSpreadElement(arg))) {
    return { form: `${head}(...)`, reason: `${args.length} expect arguments`, matcher };
  }
  if (names.length === 0) return { form: `${head}(...)`, reason: 'no matcher', matcher };
  const modifiers = names.slice(0, -1);
  const distinct = new Set(modifiers).size === modifiers.length;
  if (!distinct || modifiers.some((modifier) => !MODIFIERS.has(modifier))) {
    return { form: display, reason: 'chained form not supported', matcher };
  }
  if (!SUPPORTED_MATCHERS.has(matcher)) {
    const reason =
      matcher === 'toSatisfy' ? 'arbitrary predicate' : 'custom or unsupported matcher';
    return { form: display, reason, matcher };
  }
  return {
    form: head,
    display,
    subject: args[0],
    message: args[1] ?? null,
    modifiers,
    matcher,
    args: call.arguments,
  };
}

/** The assertion form a call starts, `expect` for an expect chain, else null. */
function assertionRoot(
  call: t.CallExpression,
  chain: Frame[],
  locals: ReadonlySet<string>,
): string | null {
  const root = rootName(call.callee);
  if (root === null) return null;
  if (root === 'expect') return 'expect';
  if (root === 'assert') return dotted(call.callee) ?? 'assert';
  if (TYPE_ASSERTIONS.has(root)) return root;
  const bare = t.isIdentifier(call.callee);
  const free = !locals.has(root) && resolveName(root, chain) === undefined;
  return bare && free && NODE_ASSERT.has(root) ? root : null;
}

// ── One run over an instance ───────────────────────────────────────────────

interface Run {
  scope: Scope;
  fullName: string | null;
  options: ChecksOptions;
  checks: { start: number; check: Check }[];
  unsupported: { start: number; form: UnsupportedForm }[];
  /** Per snapshot name (the hint, `''` without one): snapshot assertions so far. */
  counters: Map<string, number>;
  /** False once a snapshot assertion ran an unknown number of times. */
  countersKnown: boolean;
}

function reject(run: Run, node: t.Node, form: string, reason: string): void {
  run.unsupported.push({ start: node.start ?? 0, form: { line: lineOf(node), form, reason } });
}

/** A string literal, a plain template or a string row value; undefined when absent, else null. */
function staticText(node: t.Node | undefined, scope: Scope): string | null | undefined {
  if (node === undefined) return undefined;
  const inner = unwrap(node);
  if (t.isStringLiteral(inner)) return inner.value;
  if (t.isTemplateLiteral(inner) && inner.expressions.length === 0) {
    return inner.quasis[0]?.value.cooked ?? inner.quasis[0]?.value.raw ?? null;
  }
  const row = rowValueOf(inner, scope);
  return row !== null && row !== 'unknown' && row.kind === 'string' ? row.value : null;
}

/** Counts one snapshot assertion under `hint`; the count is its `.snap` key suffix. */
function bump(run: Run, hint: string | undefined): number {
  const name = hint ?? '';
  const count = (run.counters.get(name) ?? 0) + 1;
  run.counters.set(name, count);
  return count;
}

type SnapshotResult = { hash: string; args: string[] } | { reason: string };

function snapshotOf(assertion: Assertion, run: Run): SnapshotResult {
  const { scope, options } = run;
  const args = assertion.args;
  const shapeArg = (node: t.Node): string => gen(abstractNode(node, scope, false, false));
  const isProps = (node: t.Node | undefined): boolean =>
    node !== undefined && t.isObjectExpression(unwrap(node));

  const inline = (props: t.Node | undefined, snapshot?: t.Node, hint?: t.Node): SnapshotResult => {
    const hintText = staticText(hint, scope);
    if (hintText === null) {
      run.countersKnown = false;
      return { reason: 'snapshot hint not static' };
    }
    bump(run, hintText);
    const text = staticText(snapshot, scope);
    if (text === undefined) return { reason: 'inline snapshot not written' };
    if (text === null) return { reason: 'inline snapshot not static' };
    return {
      hash: sha1(stripIndentation(text)),
      args: [...(props === undefined ? [] : [shapeArg(props)]), '<snapshot>'],
    };
  };
  const snapFile = (props: t.Node | undefined, hint?: t.Node): SnapshotResult => {
    const hintText = staticText(hint, scope);
    if (hintText === null) {
      run.countersKnown = false;
      return { reason: 'snapshot hint not static' };
    }
    const count = bump(run, hintText);
    if (!run.countersKnown) return { reason: 'snapshot key unknown' };
    if (run.fullName === null) return { reason: 'test name unknown' };
    if (options.snapshots === undefined) return { reason: 'snapshot file not read' };
    const name = hintText === undefined ? run.fullName : `${run.fullName} > ${hintText}`;
    const entry = options.snapshots.entry(scope.record.file, `${name} ${count}`);
    if (entry === null) return { reason: '.snap entry missing' };
    return { hash: sha1(entry), args: props === undefined ? [] : [shapeArg(props)] };
  };
  const fileSnapshot = (target?: t.Node, hint?: t.Node): SnapshotResult => {
    const hintText = staticText(hint, scope);
    if (hintText === null) {
      run.countersKnown = false;
      return { reason: 'snapshot hint not static' };
    }
    bump(run, hintText);
    const file = staticText(target, scope);
    if (typeof file !== 'string') return { reason: 'file snapshot path not static' };
    if (options.snapshots === undefined) return { reason: 'snapshot file not read' };
    const content = options.snapshots.file(scope.record.file, file);
    if (content === null) return { reason: 'file snapshot unreadable' };
    return { hash: sha1(content), args: ['<file>'] };
  };

  // Only an object literal first argument is property matchers; anything else is the snapshot
  // text or the hint, and a non-static one is unsupported rather than guessed.
  switch (assertion.matcher) {
    case 'toMatchInlineSnapshot':
      return isProps(args[0])
        ? inline(args[0], args[1], args[2])
        : inline(undefined, args[0], args[1]);
    case 'toThrowErrorMatchingInlineSnapshot':
      return inline(undefined, args[0], args[1]);
    case 'toMatchSnapshot':
      return isProps(args[0]) ? snapFile(args[0], args[1]) : snapFile(undefined, args[0]);
    case 'toThrowErrorMatchingSnapshot':
      return snapFile(undefined, args[0]);
    default:
      return fileSnapshot(args[0], args[1]);
  }
}

function recordAssertion(call: t.CallExpression, where: string | null, run: Run): void {
  const parsed = parseAssertion(call);
  if (SNAPSHOT_MATCHERS.has(parsed.matcher) && ('reason' in parsed || where !== null)) {
    run.countersKnown = false;
  }
  if ('reason' in parsed) return reject(run, call, parsed.form, parsed.reason);
  if (where !== null) return reject(run, call, parsed.display, `inside ${where}`);
  const parts = [parsed.subject, ...parsed.args].filter((part): part is t.Node => part !== null);
  for (const part of parts) {
    t.traverseFast(part, (n) => {
      if (t.isCallExpression(n) && t.isIdentifier(n.callee, { name: 'expect' })) {
        reject(run, n, 'expect(...)', 'nested inside another assertion');
      }
    });
  }
  const { scope } = run;
  const subject =
    parsed.subject === null ? null : gen(abstractNode(parsed.subject, scope, true, false));
  const head =
    subject === null
      ? parsed.form
      : `${parsed.form}(${subject}${parsed.message === null ? '' : ',<message>'})`;
  let args: string[];
  let snapshot: string | null = null;
  if (SNAPSHOT_MATCHERS.has(parsed.matcher)) {
    const result = snapshotOf(parsed, run);
    if ('reason' in result) return reject(run, call, parsed.display, result.reason);
    snapshot = result.hash;
    args = result.args;
  } else {
    // `expect.assertions(n)` keeps its count; a matcher's arguments are expected values.
    const exact = parsed.subject === null;
    args = parsed.args.map((arg) => gen(abstractNode(arg, scope, false, exact)));
  }
  const chain = [...parsed.modifiers, parsed.matcher]
    .filter((name) => name !== '')
    .map((name) => `.${name}`)
    .join('');
  const shape = `${head}${chain}(${args.join(',')})${snapshot === null ? '' : `#${snapshot}`}`;
  run.checks.push({
    start: call.start ?? 0,
    check: {
      line: lineOf(call),
      form: parsed.form,
      modifiers: parsed.modifiers,
      matcher: parsed.matcher,
      shape,
      snapshot,
    },
  });
}

/** Walks the body; `where` names the first enclosing construct that makes a check conditional. */
function visit(node: t.Node | null | undefined, where: string | null, run: Run): void {
  if (node === null || node === undefined || typeof node.type !== 'string') return;
  const go = (child: t.Node | null | undefined, inside: string | null = where): void =>
    visit(child, inside, run);
  if (t.isCallExpression(node)) {
    const root = assertionRoot(node, run.scope.record.chain, run.scope.locals);
    if (root === 'expect') return recordAssertion(node, where, run);
    if (root !== null) return reject(run, node, root, 'not an expect assertion');
  }
  if (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.property, { name: 'should' })
  ) {
    return reject(run, node, `${dotted(node) ?? '(...)'}`, 'not an expect assertion');
  }
  if (t.isIfStatement(node)) {
    go(node.test);
    go(node.consequent, where ?? 'a conditional (if)');
    go(node.alternate, where ?? 'a conditional (if)');
    return;
  }
  if (t.isConditionalExpression(node)) {
    go(node.test);
    go(node.consequent, where ?? 'a conditional (?:)');
    go(node.alternate, where ?? 'a conditional (?:)');
    return;
  }
  if (t.isLogicalExpression(node)) {
    go(node.left);
    go(node.right, where ?? `a conditional (${node.operator})`);
    return;
  }
  if (t.isTryStatement(node)) {
    go(node.block);
    go(node.handler, where ?? 'a catch clause');
    go(node.finalizer);
    return;
  }
  const inside = t.isLoop(node)
    ? (where ?? `a loop (${node.type})`)
    : t.isSwitchStatement(node)
      ? (where ?? 'a conditional (switch)')
      : t.isFunction(node)
        ? (where ?? 'a nested function')
        : where;
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) if (isNode(child)) go(child, inside);
  }
}

// ── Helpers the body calls ─────────────────────────────────────────────────

interface HelperRef {
  name: string;
  /** The member read off a namespace import (`h.verify` → `verify`), else null. */
  member: string | null;
  label: string;
}

/** Names a call may run: its callee root (with the first member) and identifier arguments. */
function helperRefs(
  call: t.CallExpression | t.NewExpression | t.OptionalCallExpression,
): HelperRef[] {
  const refs: HelperRef[] = [];
  const callee = unwrap(call.callee);
  if (t.isIdentifier(callee)) refs.push({ name: callee.name, member: null, label: callee.name });
  else if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
    let object: t.Node = callee;
    let member: string | null = null;
    while (t.isMemberExpression(object) || t.isOptionalMemberExpression(object)) {
      member = !object.computed && t.isIdentifier(object.property) ? object.property.name : null;
      object = unwrap(object.object);
    }
    if (t.isIdentifier(object)) {
      const label = member === null ? object.name : `${object.name}.${member}`;
      refs.push({ name: object.name, member, label });
    }
  }
  for (const arg of call.arguments) {
    if (t.isIdentifier(arg)) refs.push({ name: arg.name, member: null, label: arg.name });
  }
  return refs;
}

type HelperFinding = { form: string } | { notInspected: string } | null;
type ModuleProgram = { file: string; frame: Frame } | null;

const moduleCache = new WeakMap<ModuleReader, Map<string, ModuleProgram>>();

/** The top-level frame of a helper module, parsed by Layer 0; null when it cannot be read. */
function loadModule(moduleKey: string, reader: ModuleReader | undefined): ModuleProgram {
  if (reader === undefined) return null;
  let cache = moduleCache.get(reader);
  if (cache === undefined) {
    cache = new Map();
    moduleCache.set(reader, cache);
  }
  const cached = cache.get(moduleKey);
  if (cached !== undefined) return cached;
  const source = reader.read(moduleKey);
  const programs = source === null ? null : extract([source], { isTest: () => false }).programs;
  const program = programs === null ? null : ([...programs.values()][0] ?? null);
  cache.set(moduleKey, program);
  return program;
}

/** The first assertion form reachable from a declaration, through helpers up to the depth limit. */
function declFinding(
  decl: Decl,
  member: string | null,
  chain: Frame[],
  run: Run,
  depth: number,
  seen: Set<unknown>,
): HelperFinding {
  if (decl.kind === 'node') {
    if (seen.has(decl.node)) return null;
    seen.add(decl.node);
    return nodeFinding(decl.node, chain, run, depth, seen);
  }
  const match = /^import:(.+)#([^#]+)$/.exec(decl.key);
  if (match === null || !isTestSupportFile(`${match[1]}.ts`)) return null;
  const [, moduleKey, imported] = match;
  const name = imported === '*' ? member : imported;
  const visitKey = `${moduleKey}#${name ?? '*'}`;
  if (seen.has(visitKey)) return null;
  seen.add(visitKey);
  const program = name === null ? null : loadModule(moduleKey, run.options.modules);
  const target = name === null ? undefined : program?.frame.decls.get(name);
  if (program === null || target === undefined) return { notInspected: moduleKey };
  return declFinding(target, null, [program.frame], run, depth + 1, seen);
}

function nodeFinding(
  node: t.Node,
  chain: Frame[],
  run: Run,
  depth: number,
  seen: Set<unknown>,
): HelperFinding {
  const found: { form: string | null } = { form: null };
  const calls: (t.CallExpression | t.NewExpression)[] = [];
  t.traverseFast(node, (n) => {
    if (found.form !== null) return;
    if (t.isCallExpression(n)) found.form = assertionRoot(n, chain, new Set());
    if (t.isCallExpression(n) || t.isNewExpression(n)) calls.push(n);
  });
  if (found.form !== null) return { form: found.form };
  if (depth >= HELPER_DEPTH) return null;
  for (const call of calls) {
    for (const ref of helperRefs(call)) {
      const decl = resolveName(ref.name, chain);
      const finding =
        decl === undefined ? null : declFinding(decl, ref.member, chain, run, depth + 1, seen);
      if (finding !== null) return finding;
    }
  }
  return null;
}

/** Marks each helper the body runs that asserts (or cannot be read) once, at its first call. */
function inspectHelpers(run: Run): void {
  const { scope } = run;
  const reported = new Set<string>();
  t.traverseFast(scope.record.fn.body, (node) => {
    if (
      !t.isCallExpression(node) &&
      !t.isNewExpression(node) &&
      !t.isOptionalCallExpression(node)
    ) {
      return;
    }
    for (const ref of helperRefs(node)) {
      if (reported.has(ref.label) || scope.locals.has(ref.name) || scope.rows.has(ref.name))
        continue;
      const decl = resolveName(ref.name, scope.record.chain);
      if (decl === undefined) continue;
      const finding = declFinding(decl, ref.member, scope.record.chain, run, 0, new Set());
      if (finding === null) continue;
      reported.add(ref.label);
      const reason =
        'form' in finding
          ? `assertion in helper ${ref.label} (${finding.form})`
          : `helper ${ref.label} (${finding.notInspected}) not inspected`;
      reject(run, node, ref.label, reason);
    }
  });
}

// ── Entry points ───────────────────────────────────────────────────────────

/** The checks of one test instance. */
export function computeChecks(subject: CheckSubject, options: ChecksOptions = {}): InstanceChecks {
  const run: Run = {
    scope: buildScope(subject),
    fullName: subject.fullName,
    options,
    checks: [],
    unsupported: [],
    counters: new Map(),
    countersKnown: true,
  };
  visit(subject.record.fn.body, null, run);
  inspectHelpers(run);
  const byStart = <T extends { start: number }>(items: T[]): T[] =>
    [...items].sort((a, b) => a.start - b.start);
  const checks = byStart(run.checks);
  const unsupported = byStart(run.unsupported);
  const entries = byStart([
    ...checks.map(({ start, check }) => ({ start, text: check.shape })),
    ...unsupported.map(({ start, form }) => ({ start, text: `!${form.form}: ${form.reason}` })),
  ]);
  return {
    checks: checks.map(({ check }) => check),
    unsupported: unsupported.map(({ form }) => form),
    unresolved: [...run.scope.unresolved].sort(),
    fingerprint: sha1(entries.map((entry) => entry.text).join('\n')),
  };
}

/** The check subject of an inventory instance; null without a call site. */
export function subjectOf(instance: InventoryInstance): CheckSubject | null {
  if (instance.site === null) return null;
  return { record: instance.site.record, instance: instance.instance, fullName: instance.fullName };
}

/**
 * The checks-and-context key (KTD5): instances sharing it are Layer 1 candidates. null without a
 * call site, or when the body has no assertion at all (nothing to compare).
 */
export function checksContextKey(
  input: InventoryInstance | CheckSubject,
  options: ChecksOptions = {},
): string | null {
  const subject = 'record' in input ? input : subjectOf(input);
  if (subject === null) return null;
  const checks = computeChecks(subject, options);
  if (checks.checks.length === 0 && checks.unsupported.length === 0) return null;
  return sha1(`${checks.fingerprint}\0${contextOf(subject.record).hash}`);
}

// ── File system readers ────────────────────────────────────────────────────

/** `root` joined with a repo path, or null when the path escapes the root. */
function insideRoot(root: string, repoPath: string): string | null {
  try {
    return path.join(root, normalizeRelativePath(repoPath));
  } catch {
    return null;
  }
}

function readText(file: string | null): string | null {
  if (file === null) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** `exports[\`key\`] = \`value\`` entries of a `.snap` file (parsed, never evaluated). */
function parseSnapFile(text: string): Map<string, string> | null {
  let program: t.Program;
  try {
    program = parse(text, { sourceType: 'script' }).program;
  } catch {
    return null;
  }
  const entries = new Map<string, string>();
  for (const statement of program.body) {
    if (!t.isExpressionStatement(statement)) continue;
    const assignment = statement.expression;
    if (!t.isAssignmentExpression(assignment) || !t.isMemberExpression(assignment.left)) continue;
    const { object, property } = assignment.left;
    if (!t.isIdentifier(object, { name: 'exports' }) || !assignment.left.computed) continue;
    const key = t.isTemplateLiteral(property)
      ? property.quasis[0]?.value.cooked
      : t.isStringLiteral(property)
        ? property.value
        : undefined;
    const value = assignment.right;
    if (key === undefined || key === null) continue;
    if (!t.isTemplateLiteral(value) || value.expressions.length > 0) continue;
    entries.set(key, value.quasis[0]?.value.raw ?? '');
  }
  return entries;
}

/** Reads `.snap` entries and file snapshots under `repoRoot`; paths that escape it read null. */
export function fsSnapshotReader(repoRoot: string): SnapshotReader {
  const snapFiles = new Map<string, Map<string, string> | null>();
  return {
    entry(testFile, key) {
      const snapPath = path.posix.join(
        path.posix.dirname(testFile),
        '__snapshots__',
        `${path.posix.basename(testFile)}.snap`,
      );
      let entries = snapFiles.get(snapPath);
      if (entries === undefined) {
        const text = readText(insideRoot(repoRoot, snapPath));
        entries = text === null ? null : parseSnapFile(text);
        snapFiles.set(snapPath, entries);
      }
      return entries?.get(key) ?? null;
    },
    file(testFile, snapshotPath) {
      if (path.posix.isAbsolute(snapshotPath)) return null;
      const target = path.posix.join(path.posix.dirname(testFile), snapshotPath);
      return readText(insideRoot(repoRoot, target));
    },
  };
}

/** Extensions tried for a module key, in TypeScript's resolution order. */
const MODULE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.js',
];

/** Reads helper modules under `repoRoot` by module key. */
export function fsModuleReader(repoRoot: string): ModuleReader {
  return {
    read(moduleKey) {
      for (const extension of MODULE_EXTENSIONS) {
        const repoPath = `${moduleKey}${extension}`;
        const source = readText(insideRoot(repoRoot, repoPath));
        if (source !== null) return { path: repoPath, source };
      }
      return null;
    },
  };
}
