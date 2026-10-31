/**
 * Test side of the value-flow check (U10, R9, KTD11 "Test side (Babel)", design §5.3a step 1).
 * For a facet-equal pair, each differing discarded value (U6 `DiscardedValue`: same position and
 * kind, another value) is bound to where it enters production code, by climbing the test file's
 * Babel AST from the value's node with `@babel/traverse` scope bindings:
 *  - `call-argument`: the value is an argument of a call or `new` expression (`roundScore(2.4)`),
 *    directly or through a `const` the test declares (`const raw = 2.4; roundScore(raw)`);
 *  - `fixture-field`: the value sits inside an object or array literal passed as an argument
 *    (`configure({ ratio: 2.4 })`); `path` names the field (`ratio`, `[0]`);
 *  - `table-key`: the value is a row of the test's own `it.each` / `test.for` table (U6 origin
 *    `row`), read by the body where it reaches a call argument.
 * Each entry records the callee's source text, the UTF-16 offset of the identifier naming it (the
 * checker's lookup position, checker.ts) and the argument index.
 *
 * Roles: a value that reaches only matchers (`expect(x).toBe(v)`, `.toContain(v)`, asymmetric
 * matchers such as `expect.objectContaining(...)`) or the `expect` subject itself is an expected
 * value. A differing expected value follows the input that produced it, so it adds no entry when
 * an input of the pair differs; when only expected values differ the pair is unknown with reason
 * `expected-only` (KTD11). A value that test code transforms first (`2.4 * 2`, `'a'.trim()`),
 * that reaches no call, or that the two tests bind to different entries is unknown; so is a pair
 * whose discarded positions do not align.
 *
 * Library only; pdg-walk.ts `staticValueFlow` calls {@link bindPair}.
 */
import { parse } from '@babel/parser';
import traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { CaseRecord } from '../../test-dupes/test-dupes.js';
import type { DiscardedValue, SourceLocation } from '../facet/input-facet.js';

export type EntryKind = 'call-argument' | 'fixture-field' | 'table-key';

/** Where one differing value enters production code. */
export interface Entry {
  kind: EntryKind;
  /** U6 facet slot. */
  position: number;
  /** The callee's source text: `roundScore`, `parser.parse`, `Box`. */
  callee: string;
  /** The identifier naming the callee (`roundScore`, `parse`, `Box`). */
  calleeName: string;
  /** UTF-16 offset of that identifier in the test file: the checker's position. */
  calleeOffset: number;
  isNew: boolean;
  argIndex: number;
  /** Field path inside the argument (`ratio`, `[0]`); empty for the argument itself. */
  path: string[];
  /** The call's location in the test file. */
  location: SourceLocation;
}

/** One test of the pair as the binder sees it. */
export interface BindSide {
  /** Repo path of the test file. */
  file: string;
  /** The test file's text (the one the facet was computed from). */
  source: string;
  /** UTF-16 offsets of the test callback (`CaseRecord.fn`). */
  fn: { start: number; end: number };
  /** The instance's discarded values (U6). */
  discarded: readonly DiscardedValue[];
}

export type PositionRole = 'input' | 'expected' | 'unbound';

export interface PositionBinding {
  position: number;
  /** The two tests' values. */
  values: [string, string];
  role: PositionRole;
  /** Entries per test; empty unless the role is `input`. */
  entries: [Entry[], Entry[]];
}

export interface BindResult {
  /** `not-required` when no discarded value differs. */
  status: 'bound' | 'unknown' | 'not-required';
  /** Sorted, distinct; empty when bound. */
  reasons: string[];
  positions: PositionBinding[];
  /** First test's entries of the input positions, in position order; empty unless bound. */
  entries: Entry[];
}

const PLUGINS: ['typescript', 'jsx', 'decorators-legacy'] = [
  'typescript',
  'jsx',
  'decorators-legacy',
];
const WRAPPERS: ReadonlySet<string> = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
]);

/** The bind side of a Layer 0 record. */
export function bindSideOf(
  record: CaseRecord,
  discarded: readonly DiscardedValue[],
  source: string,
): BindSide {
  return {
    file: record.file,
    source,
    fn: { start: record.fn.start ?? 0, end: record.fn.end ?? 0 },
    discarded,
  };
}

// ── Parsing ────────────────────────────────────────────────────────────────

interface ParsedTest {
  /** Every node path by `<line>:<column>` of its start. */
  byStart: Map<string, NodePath[]>;
}

/** Parsed test files, most recent last; bounded because a run binds hundreds of files. */
const parsedCache = new Map<string, ParsedTest | null>();
const PARSED_CACHE_SIZE = 32;

function parsed(source: string): ParsedTest | null {
  const cached = parsedCache.get(source);
  if (cached !== undefined) return cached;
  let result: ParsedTest | null = null;
  try {
    const ast = parse(source, { sourceType: 'module', plugins: PLUGINS, errorRecovery: true });
    const byStart = new Map<string, NodePath[]>();
    traverse(ast, {
      enter(path) {
        const start = path.node.loc?.start;
        if (start === undefined) return;
        const key = `${start.line}:${start.column}`;
        const list = byStart.get(key) ?? [];
        list.push(path);
        byStart.set(key, list);
      },
    });
    result = { byStart };
  } catch {
    result = null;
  }
  parsedCache.set(source, result);
  if (parsedCache.size > PARSED_CACHE_SIZE)
    parsedCache.delete(parsedCache.keys().next().value ?? '');
  return result;
}

/** The node of a discarded value inside the test callback, else a reason. */
function valueNode(side: BindSide, value: DiscardedValue): NodePath | string {
  const test = parsed(side.source);
  if (test === null) return 'test file does not parse';
  const { line, column } = value.location;
  const inside = (path: NodePath): boolean =>
    (path.node.start ?? -1) >= side.fn.start && (path.node.end ?? -1) <= side.fn.end;
  // `{ ratio }`: the shorthand key and value start together; the value is the read.
  const isKey = (path: NodePath): boolean =>
    path.parentPath !== null &&
    path.parentPath.isObjectProperty() &&
    path.parentPath.node.key === path.node &&
    !path.parentPath.node.computed;
  const candidates = (test.byStart.get(`${line}:${column}`) ?? []).filter(
    (path) => inside(path) && !isKey(path),
  );
  const pick = candidates.find((path) => {
    const node = path.node;
    if (value.origin === 'row') return t.isIdentifier(node);
    if (value.kind === 'string') return t.isStringLiteral(node) || t.isTemplateLiteral(node);
    if (value.kind === 'bigint') return t.isBigIntLiteral(node) || t.isUnaryExpression(node);
    return t.isNumericLiteral(node) || t.isUnaryExpression(node, { operator: '-' });
  });
  return pick ?? `value not found at ${line}:${column}`;
}

// ── The climb ──────────────────────────────────────────────────────────────

type Use =
  | { kind: 'entry'; entry: Omit<Entry, 'position' | 'kind'>; nested: boolean }
  | { kind: 'expected' }
  | { kind: 'unbound'; reason: string };

/** True for `expect(...)`, `expect.soft(...)` and matcher chains rooted at one. */
function isExpectCall(node: t.Node): boolean {
  if (!t.isCallExpression(node)) return false;
  const callee = node.callee;
  if (t.isIdentifier(callee, { name: 'expect' })) return true;
  if (t.isMemberExpression(callee)) {
    if (t.isIdentifier(callee.object, { name: 'expect' })) return true;
    return isMatcherChain(callee.object);
  }
  return false;
}

function isMatcherChain(node: t.Node): boolean {
  let current = node;
  while (t.isMemberExpression(current)) current = current.object;
  return isExpectCall(current);
}

function calleeIdentifier(callee: t.Node): t.Identifier | null {
  let node = callee;
  while (WRAPPERS.has(node.type)) node = (node as t.TSAsExpression).expression;
  if (t.isIdentifier(node)) return node;
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
    return node.property;
  }
  return null;
}

function usesOf(start: NodePath, side: BindSide, seen: Set<t.Node>): Use[] {
  const path: string[] = [];
  let current = start;
  for (;;) {
    const parentPath = current.parentPath;
    if (parentPath === null) return [{ kind: 'unbound', reason: 'unbound (outside the test)' }];
    const parent = parentPath.node;
    const node = current.node;
    if (WRAPPERS.has(parent.type)) {
      current = parentPath;
      continue;
    }
    if (t.isUnaryExpression(parent, { operator: '-' }) && t.isNumericLiteral(node)) {
      current = parentPath;
      continue;
    }
    if (t.isArrayExpression(parent)) {
      path.unshift(`[${parent.elements.indexOf(node as t.Expression)}]`);
      current = parentPath;
      continue;
    }
    if (t.isObjectProperty(parent) && (parent.value === node || parent.computed)) {
      const key = parent.key;
      path.unshift(
        parent.key === node
          ? '[key]'
          : t.isIdentifier(key) && !parent.computed
            ? key.name
            : t.isStringLiteral(key)
              ? key.value
              : '[computed]',
      );
      const object = parentPath.parentPath;
      if (object === null || !object.isObjectExpression()) {
        return [{ kind: 'unbound', reason: 'unbound (destructuring pattern)' }];
      }
      current = object;
      continue;
    }
    if (t.isVariableDeclarator(parent) && parent.init === node) {
      if (!t.isIdentifier(parent.id)) {
        return [{ kind: 'unbound', reason: 'unbound (destructured)' }];
      }
      const binding = parentPath.scope.getBinding(parent.id.name);
      if (binding === undefined || !binding.constant) {
        return [{ kind: 'unbound', reason: `unbound (${parent.id.name} is reassigned)` }];
      }
      if (binding.referencePaths.length === 0) {
        return [{ kind: 'unbound', reason: 'unbound (never read)' }];
      }
      if (seen.has(parent)) return [{ kind: 'unbound', reason: 'unbound (cycle)' }];
      seen.add(parent);
      return binding.referencePaths.flatMap((reference) =>
        usesOf(reference, side, seen).map((use) =>
          use.kind === 'entry' && path.length > 0
            ? { ...use, entry: { ...use.entry, path: [...path, ...use.entry.path] }, nested: true }
            : use,
        ),
      );
    }
    if (t.isCallExpression(parent) || t.isNewExpression(parent)) {
      if (parent.callee === node) {
        return [{ kind: 'unbound', reason: 'derived in the test (method call on the value)' }];
      }
      if (t.isCallExpression(parent) && (isExpectCall(parent) || isAsymmetricMatcher(parent))) {
        return [{ kind: 'expected' }];
      }
      const argIndex = parent.arguments.indexOf(node as t.Expression);
      const spreadBefore = parent.arguments
        .slice(0, Math.max(argIndex, 0) + 1)
        .some((argument) => t.isSpreadElement(argument));
      const name = calleeIdentifier(parent.callee);
      if (argIndex < 0 || spreadBefore || name === null) {
        return [{ kind: 'unbound', reason: 'unbound (unsupported call shape)' }];
      }
      const start = parent.loc?.start;
      return [
        {
          kind: 'entry',
          nested: path.length > 0,
          entry: {
            callee: side.source.slice(parent.callee.start ?? 0, parent.callee.end ?? 0),
            calleeName: name.name,
            calleeOffset: name.start ?? 0,
            isNew: t.isNewExpression(parent),
            argIndex,
            path,
            location: { file: side.file, line: start?.line ?? 0, column: start?.column ?? 0 },
          },
        },
      ];
    }
    if (
      (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) &&
      parent.object === node
    ) {
      const outer = parentPath.parent;
      if (
        (t.isCallExpression(outer) || t.isOptionalCallExpression(outer)) &&
        outer.callee === parent
      ) {
        return [{ kind: 'unbound', reason: 'derived in the test (method call on the value)' }];
      }
      // A field of a row value (`row.input`): the field is the value.
      current = parentPath;
      continue;
    }
    if (t.isExpressionStatement(parent) || t.isFunction(parent) || t.isStatement(parent)) {
      return [{ kind: 'unbound', reason: 'unbound (reaches no call)' }];
    }
    return [{ kind: 'unbound', reason: `derived in the test (${parent.type})` }];
  }
}

/** `expect.objectContaining(...)`, `expect.any(...)` and other asymmetric matchers. */
function isAsymmetricMatcher(node: t.CallExpression): boolean {
  const callee = node.callee;
  return (
    t.isMemberExpression(callee) &&
    (t.isIdentifier(callee.object, { name: 'expect' }) ||
      (t.isMemberExpression(callee.object) &&
        t.isIdentifier(callee.object.object, { name: 'expect' })))
  );
}

interface SideBinding {
  role: PositionRole;
  entries: Entry[];
  reasons: string[];
}

function bindValue(side: BindSide, value: DiscardedValue): SideBinding {
  const start = valueNode(side, value);
  if (typeof start === 'string') return { role: 'unbound', entries: [], reasons: [start] };
  const uses = usesOf(start, side, new Set());
  const unbound = uses.flatMap((use) => (use.kind === 'unbound' ? [use.reason] : []));
  if (unbound.length > 0) return { role: 'unbound', entries: [], reasons: unbound };
  const entries = uses.flatMap((use): Entry[] =>
    use.kind === 'entry'
      ? [
          {
            ...use.entry,
            position: value.position,
            kind:
              value.origin === 'row' ? 'table-key' : use.nested ? 'fixture-field' : 'call-argument',
          },
        ]
      : [],
  );
  if (entries.length === 0) return { role: 'expected', entries: [], reasons: [] };
  return { role: 'input', entries, reasons: [] };
}

const entryKey = (entry: Entry): string =>
  `${entry.kind}|${entry.callee}|${entry.isNew}|${entry.argIndex}|${entry.path.join('.')}`;

// ── The pair ───────────────────────────────────────────────────────────────

/** The positions where two tests' discarded values differ; null when the slots do not align. */
export function differingValues(
  a: readonly DiscardedValue[],
  b: readonly DiscardedValue[],
): [DiscardedValue, DiscardedValue][] | null {
  if (a.length !== b.length) return null;
  const out: [DiscardedValue, DiscardedValue][] = [];
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left.position !== right.position || left.kind !== right.kind) return null;
    if (left.value !== right.value) out.push([left, right]);
  }
  return out;
}

/** Binds a pair's differing discarded values to their production entries. */
export function bindPair(a: BindSide, b: BindSide): BindResult {
  const differing = differingValues(a.discarded, b.discarded);
  if (differing === null) {
    return {
      status: 'unknown',
      reasons: ['discarded values do not align'],
      positions: [],
      entries: [],
    };
  }
  if (differing.length === 0) {
    return { status: 'not-required', reasons: [], positions: [], entries: [] };
  }
  const reasons = new Set<string>();
  const positions: PositionBinding[] = differing.map(([left, right]) => {
    const first = bindValue(a, left);
    const second = bindValue(b, right);
    const role: PositionRole = first.role === second.role ? first.role : 'unbound';
    for (const reason of [...first.reasons, ...second.reasons]) {
      reasons.add(`position ${left.position}: ${reason}`);
    }
    const symmetric =
      first.role === second.role &&
      JSON.stringify(first.entries.map(entryKey)) === JSON.stringify(second.entries.map(entryKey));
    if (first.role !== 'unbound' && second.role !== 'unbound' && !symmetric) {
      reasons.add(`position ${left.position}: the two tests bind it differently`);
    }
    return {
      position: left.position,
      values: [left.value, right.value],
      role,
      entries: [first.entries, second.entries],
    };
  });
  if (reasons.size === 0 && positions.every((position) => position.role === 'expected')) {
    reasons.add('expected-only');
  }
  if (reasons.size > 0) {
    return { status: 'unknown', reasons: [...reasons].sort(), positions, entries: [] };
  }
  const entries = positions.flatMap((position) =>
    position.role === 'input' ? position.entries[0] : [],
  );
  return { status: 'bound', reasons: [], positions, entries };
}
