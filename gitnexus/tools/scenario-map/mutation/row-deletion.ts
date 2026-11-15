/**
 * Row-deletion operator of the scenario map (U9, R8, KTD10, design §5.4 "Row-deletion operator").
 * Stryker never mutates object keys, so two tests that read two rows of one production table can
 * kill the same mutants and still pin different rows. Deleting each row in turn tells them apart.
 *
 * Plan ({@link planRowDeletion}, pure). The pair's differing discarded values are the U6 facet
 * entries at the same position with the same kind and another value. For each such position the
 * two values (strings trimmed, numbers as numbers: the facet's table keys) must both be keys or
 * entries of ONE supported production table:
 *   - the search goes tier by tier like the facet's (design §5.3 rule 3; property columns never
 *     count): the production files either test executed, then their two-hop import closure
 *     ({@link pairTableSearch}); the first tier in which U6's table index (tables.ts `factsOf`)
 *     has a table holding both values decides;
 *   - in that tier's files, the supported constructs whose key set equals such an index table:
 *     an object literal (plain identifier or string keys), `new Set([...])` (literal entries) or
 *     `new Map([...])` (`[key, value]` entries with literal keys), possibly under `as`,
 *     `satisfies`, `!` or `Object.freeze(...)`;
 *   - none: the position is not applicable (`no-common-table`: no table holds both values;
 *     `no-supported-table`: only an array, switch or regex table does); more than one:
 *     `ambiguous-table` (deleting from the wrong one would read as "neither fails");
 *   - the one table is unsupported (`unsupported-table: <construct>`) when it holds a spread, a
 *     computed key, a getter or setter, a duplicate key or a non-literal entry, or is wrapped in
 *     `new Proxy(...)` or passed to `Object.assign(...)`, or when the declaring module (only that
 *     module) writes into it through its binding: an assignment, `++`/`--` or `delete` on a
 *     member, a member in a destructuring or `for…in/of` target, a call of `add`, `set`,
 *     `delete` or `clear`, `Object.assign/defineProperty/defineProperties/setPrototypeOf` or
 *     `Reflect.set/defineProperty/deleteProperty/setPrototypeOf` on it, `new Proxy(<it>, …)`, or
 *     a reassignment of the binding. A table that is neither bound to a declaration nor read in
 *     place (`{…}[k]`) is `untracked`: its writes cannot be checked. A module that does not parse
 *     is `unparseable`. Not seen (accepted limits of the one-module scan): writes from another
 *     module, through an alias of the binding, or by a function the table is passed to.
 * Each planned position deletes its two keys (deduplicated across positions): the entry's text
 * and its trailing comma, if any, are spliced out of the source, never regenerated, and the result
 * must parse (`splice-unparseable`). The global id is prepare/mutant-identity.ts `formatGlobalId`
 * over the original file's repo path and content hash, the entry's span (1-based lines and
 * columns, end exclusive), mutator {@link ROW_DELETION_MUTATOR} and an empty replacement.
 *
 * Runs ({@link runRowDeletion}). One throwaway copy per batch: `<work>/row-deletion/prepared`,
 * prepared like a shard's copy (tools/mutation/prepare, nothing blanked) and verified against the
 * run manifest (run-group.ts `verifyPreparedCopy`, else `manifest-mismatch` and nothing runs);
 * each table file's copy must have the planned content hash (`copy-mismatch`). Per pair, through
 * vitest-run.ts `runVitest` with the pair's two test ids, each call a fresh Vitest instance (a
 * reused one would serve cached transforms and turn a deletion into a false "neither fails"):
 *   1. a control run of the unedited copy: both tests pass (`control-failed`), and the run's Vite
 *      module graph shows every table file transformed (`probeFiles`/`loadedFiles`, else
 *      `edit-not-loaded`); either problem makes the pair inconclusive and runs no deletion;
 *   2. one run per deletion, with the spliced text written into the copy and the original text
 *      restored after the run, whatever happens; a run that throws is inconclusive (`run-error`).
 * Scratch: `<work>/row-deletion/pairs/<pair digest>/{control,deletion-<n>}/`.
 *
 * Outcomes. A deletion run ({@link classifyDeletionRun}) is inconclusive when the run is invalid,
 * errored or timed out, has an outside-test row, a test without a pass or an assertion failure (a
 * runtime error, a timeout, a hook: runner/classify-outcome.ts classes), or did not load the
 * edited file; else it is asymmetric when exactly one test fails by assertion (Row) and symmetric
 * when both or neither do. The pair ({@link combineRowDeletion}) is asymmetric if any deletion is,
 * else inconclusive if any deletion or position is, else symmetric if any deletion ran, else not
 * applicable. Design §2: symmetric and not applicable allow strong evidence, inconclusive caps it
 * at weak, asymmetric is Row.
 *
 * Library only; the scenario-map CLI (U14) plans the pairs and calls {@link runRowDeletion}. The
 * runner and the copy are injected ({@link RowDeletionDeps}), so unit tests never spawn Vitest.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
  contentHash,
  formatGlobalId,
  type MutantIdentity,
  type ReportLocation,
} from '../../mutation/prepare/mutant-identity.js';
import { PACKAGE_DIR, buildPathMap, toPreparedPath } from '../../mutation/prepare/path-map.js';
import {
  prepare,
  type PrepareOptions,
  type PrepareReport,
} from '../../mutation/prepare/prepare.js';
import type { OutcomeClass } from '../../mutation/runner/classify-outcome.js';
import { errorMessage } from '../../mutation/shared/cli.js';
import { overlaps } from '../../mutation/shared/fs.js';
import type {
  DiscardedValue,
  FacetContext,
  FacetSubject,
  InputFacet,
} from '../facet/input-facet.js';
import {
  numberKey,
  stringKey,
  type LiteralKey,
  type TableIndex,
  type TableSearch,
} from '../facet/tables.js';
import { extraRootsOf } from '../types.js';
import { byText, sha256, sortedUnique } from '../util.js';
import { verifyPreparedCopy, type ScenarioRunManifest } from './run-group.js';
import {
  runVitest,
  vitestSelectionOf,
  type VitestRunOptions,
  type VitestRunResult,
} from './vitest-run.js';

/** The mutator name of a row deletion's global id. */
export const ROW_DELETION_MUTATOR = 'RowDeletion';

export type RowDeletionOutcome = 'symmetric' | 'asymmetric' | 'not-applicable' | 'inconclusive';
export type DeletionOutcome = 'symmetric' | 'asymmetric' | 'inconclusive';

/** A construct that makes a table unsupported (design §5.4); see the module comment. */
export type UnsupportedConstruct =
  | 'spread'
  | 'computed-key'
  | 'getter'
  | 'setter'
  | 'duplicate-key'
  | 'non-literal-entry'
  | 'object-assign'
  | 'proxy'
  | 'write'
  | 'untracked';

export type TableKind = 'object' | 'Set' | 'Map';

export interface RowTable {
  /** Repo path of the declaring production file. */
  file: string;
  kind: TableKind;
  /** The declared binding; null for a table read in place. */
  binding: string | null;
  /** 1-based line of the literal. */
  line: number;
}

export interface PlannedDeletion {
  globalId: string;
  identity: MutantIdentity;
  /** The deleted key or entry (tables.ts `LiteralKey`). */
  key: LiteralKey;
  table: RowTable;
  /** Offsets in the original text, end exclusive: the entry and its trailing comma. */
  splice: { start: number; end: number };
}

export interface PositionPlan {
  /** Facet slot index (U6 `DiscardedValue.position`). */
  position: number;
  /** The two tests' values at the position. */
  values: [string, string];
  status: 'planned' | 'not-applicable' | 'inconclusive';
  /** Why the position is not planned; empty when it is. */
  reasons: string[];
  table: RowTable | null;
}

export interface RowDeletionPlan {
  /** Phase 0 ids of the pair's tests. */
  a: string;
  b: string;
  /** `planned` when at least one deletion is planned. */
  status: 'planned' | 'not-applicable' | 'inconclusive';
  /** Reasons of the unplanned positions, sorted and distinct. */
  reasons: string[];
  positions: PositionPlan[];
  /** Distinct global ids, in position order. */
  deletions: PlannedDeletion[];
}

export interface RowDeletionPairInput {
  a: string;
  b: string;
  /** The U6 facets of `a` and `b`. */
  facets: readonly [InputFacet, InputFacet];
  /** Where the table is searched ({@link pairTableSearch}). */
  search: TableSearch;
}

export interface RowDeletionEnv {
  /** The run's table index (FacetContext `tables`). */
  tables: TableIndex;
  /** Text of a repo path, null when it cannot be read; the index's sources. */
  read: (repoPath: string) => string | null;
}

const PLUGINS: ['typescript', 'decorators-legacy'] = ['typescript', 'decorators-legacy'];
/** Nodes between a table literal and its use that keep its value. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'ParenthesizedExpression',
]);
const MUTATING_METHODS: ReadonlySet<string> = new Set(['add', 'set', 'delete', 'clear']);
const WRITING_CALLS: ReadonlySet<string> = new Set([
  'Object.defineProperty',
  'Object.defineProperties',
  'Object.setPrototypeOf',
  'Reflect.set',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.setPrototypeOf',
]);

// ── Table search ───────────────────────────────────────────────────────────

/**
 * The tiers a pair's table is searched in: the production files either test executed (Layer 1
 * provenance), then the production files within two import hops of either test file (the facet's
 * second tier). Both sorted and distinct.
 */
export function pairTableSearch(ctx: FacetContext, subjects: readonly FacetSubject[]): TableSearch {
  const executed = subjects.flatMap((subject) =>
    (subject.executedFiles ?? []).filter((file) => ctx.isProduction(file)),
  );
  const closure = subjects.flatMap((subject) => ctx.closureOf(subject)?.near ?? []);
  return { executed: sortedUnique(executed), closure: sortedUnique(closure) };
}

/** A discarded value as the table index holds it; null for values no table holds. */
function tableKeyOf(entry: DiscardedValue): LiteralKey | null {
  if (entry.kind === 'string') return stringKey(entry.value.trim());
  if (entry.kind !== 'number') return null;
  const value = Number(entry.value);
  return Number.isFinite(value) ? numberKey(value) : null;
}

// ── Table constructs of a module ───────────────────────────────────────────

interface ScannedTable extends RowTable {
  values: ReadonlySet<LiteralKey>;
  /** The node of each key's first entry. */
  entries: ReadonlyMap<LiteralKey, t.Node>;
  unsupported: ReadonlySet<UnsupportedConstruct>;
}

/** A string literal or a plain template's text, else null (tables.ts `stringOf`). */
function stringOf(node: t.Node | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** A Set entry or Map key as the table index holds it (tables.ts `entryKey`), else null. */
function entryKeyOf(node: t.Node | null | undefined): LiteralKey | null {
  if (node === null || node === undefined) return null;
  if (t.isNumericLiteral(node)) return numberKey(node.value);
  if (t.isUnaryExpression(node, { operator: '-' }) && t.isNumericLiteral(node.argument)) {
    return numberKey(-node.argument.value);
  }
  const text = stringOf(node);
  return text !== null && text.length > 0 ? stringKey(text) : null;
}

/** An object property's key as the table index holds it (tables.ts `objectKeyOf`), else null. */
function objectKeyOf(property: t.ObjectProperty | t.ObjectMethod): LiteralKey | null {
  const text = property.computed
    ? stringOf(property.key)
    : t.isIdentifier(property.key)
      ? property.key.name
      : t.isStringLiteral(property.key)
        ? property.key.value
        : null;
  return text !== null && text.length > 0 ? stringKey(text) : null;
}

/** `Object.assign` for `Object.assign(...)`, `Proxy` for `new Proxy(...)`: the callee's name. */
function calleeName(callee: t.Node): string | null {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.object)) {
    return t.isIdentifier(callee.property) ? `${callee.object.name}.${callee.property.name}` : null;
  }
  return null;
}

function memberName(member: t.MemberExpression | t.OptionalMemberExpression): string | null {
  if (!member.computed && t.isIdentifier(member.property)) return member.property.name;
  return stringOf(member.property);
}

/** The outermost path above `path` that only wraps its value. */
function unwrap(path: NodePath): NodePath {
  let current = path;
  for (;;) {
    const parent = current.parentPath;
    if (parent === null) return current;
    const frozen =
      t.isCallExpression(parent.node) &&
      calleeName(parent.node.callee) === 'Object.freeze' &&
      parent.node.arguments.length === 1 &&
      parent.node.arguments[0] === current.node;
    if (!WRAPPERS.has(parent.node.type) && !frozen) return current;
    current = parent;
  }
}

/** True when a member expression is the target of a destructuring or `for…in/of` assignment. */
function isPatternTarget(member: NodePath): boolean {
  const parent = member.parentPath;
  if (parent === null) return false;
  const node = parent.node;
  if (t.isArrayPattern(node) || t.isRestElement(node)) return true;
  if (t.isAssignmentPattern(node)) return node.left === member.node;
  if (t.isObjectProperty(node)) {
    return t.isObjectPattern(parent.parent) && node.value === member.node;
  }
  if (t.isForOfStatement(node) || t.isForInStatement(node)) return node.left === member.node;
  return false;
}

/** What one reference to the table's binding does to it; empty for a read. */
function referenceUse(reference: NodePath): UnsupportedConstruct[] {
  const use = unwrap(reference);
  const parent = use.parentPath;
  if (parent === null) return [];
  const node = parent.node;
  if (
    (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
    node.object === use.node
  ) {
    const outer = parent.parent;
    if (t.isAssignmentExpression(outer) && outer.left === node) return ['write'];
    if (t.isUpdateExpression(outer)) return ['write'];
    if (t.isUnaryExpression(outer, { operator: 'delete' })) return ['write'];
    const called =
      (t.isCallExpression(outer) || t.isOptionalCallExpression(outer)) && outer.callee === node;
    if (called && MUTATING_METHODS.has(memberName(node) ?? '')) return ['write'];
    return isPatternTarget(parent) ? ['write'] : [];
  }
  if ((t.isCallExpression(node) || t.isNewExpression(node)) && node.arguments[0] === use.node) {
    const callee = calleeName(node.callee) ?? '';
    if (t.isNewExpression(node)) return callee === 'Proxy' ? ['proxy'] : [];
    if (callee === 'Object.assign') return ['object-assign'];
    if (WRITING_CALLS.has(callee)) return ['write'];
  }
  return [];
}

/** How a table literal is held: its binding and what the module does to it. */
function usageOf(literal: NodePath): {
  binding: string | null;
  unsupported: UnsupportedConstruct[];
} {
  const root = unwrap(literal);
  const parent = root.parentPath;
  const node = parent?.node;
  if (
    parent &&
    t.isVariableDeclarator(node) &&
    node.init === root.node &&
    t.isIdentifier(node.id)
  ) {
    const name = node.id.name;
    const binding = parent.scope.getBinding(name);
    if (binding === undefined) return { binding: name, unsupported: ['untracked'] };
    const unsupported: UnsupportedConstruct[] =
      binding.constantViolations.length > 0 ? ['write'] : [];
    for (const reference of binding.referencePaths) unsupported.push(...referenceUse(reference));
    return { binding: name, unsupported };
  }
  if (
    (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
    node.object === root.node
  ) {
    return { binding: null, unsupported: [] };
  }
  if (t.isNewExpression(node) && calleeName(node.callee) === 'Proxy') {
    return { binding: null, unsupported: ['proxy'] };
  }
  if (t.isCallExpression(node) && calleeName(node.callee) === 'Object.assign') {
    return { binding: null, unsupported: ['object-assign'] };
  }
  return { binding: null, unsupported: ['untracked'] };
}

interface EntryScan {
  entries: Map<LiteralKey, t.Node>;
  unsupported: UnsupportedConstruct[];
}

function addEntry(scan: EntryScan, key: LiteralKey, node: t.Node): void {
  if (scan.entries.has(key)) scan.unsupported.push('duplicate-key');
  else scan.entries.set(key, node);
}

function objectEntries(node: t.ObjectExpression): EntryScan {
  const scan: EntryScan = { entries: new Map(), unsupported: [] };
  for (const property of node.properties) {
    if (t.isSpreadElement(property)) {
      scan.unsupported.push('spread');
      continue;
    }
    if (property.computed) scan.unsupported.push('computed-key');
    if (t.isObjectMethod(property) && property.kind === 'get') scan.unsupported.push('getter');
    if (t.isObjectMethod(property) && property.kind === 'set') scan.unsupported.push('setter');
    const key = objectKeyOf(property);
    if (key !== null) addEntry(scan, key, property);
  }
  return scan;
}

function collectionEntries(kind: 'Set' | 'Map', array: t.ArrayExpression): EntryScan {
  const scan: EntryScan = { entries: new Map(), unsupported: [] };
  for (const element of array.elements) {
    const keyNode = kind === 'Set' || !t.isArrayExpression(element) ? element : element.elements[0];
    if (t.isSpreadElement(element) || t.isSpreadElement(keyNode)) {
      scan.unsupported.push('spread');
      continue;
    }
    const key = entryKeyOf(keyNode);
    if (key === null || element === null) scan.unsupported.push('non-literal-entry');
    else addEntry(scan, key, element);
  }
  return scan;
}

const parseModule = (source: string): t.File =>
  parse(source, { sourceType: 'module', plugins: PLUGINS });

/** Every object literal, `new Set([...])` and `new Map([...])` of a module; null when it does not parse. */
function scanTables(file: string, source: string): ScannedTable[] | null {
  let ast: t.File;
  try {
    ast = parseModule(source);
  } catch {
    return null;
  }
  return tablesIn(file, ast);
}

/** {@link scanTables} over a parsed module; null when the traversal throws. */
function tablesIn(file: string, ast: t.File): ScannedTable[] | null {
  const tables: ScannedTable[] = [];
  const record = (kind: TableKind, literal: NodePath, scan: EntryScan): void => {
    if (scan.entries.size < 2) return;
    const usage = usageOf(literal);
    tables.push({
      file,
      kind,
      binding: usage.binding,
      line: literal.node.loc?.start.line ?? 0,
      values: new Set(scan.entries.keys()),
      entries: scan.entries,
      unsupported: new Set([...scan.unsupported, ...usage.unsupported]),
    });
  };
  try {
    traverse(ast, {
      ObjectExpression(path) {
        record('object', path, objectEntries(path.node));
      },
      NewExpression(path) {
        const { callee, arguments: args } = path.node;
        const array = args[0];
        if (!t.isIdentifier(callee) || !t.isArrayExpression(array)) return;
        if (callee.name === 'Set' || callee.name === 'Map') {
          record(callee.name, path, collectionEntries(callee.name, array));
        }
      },
    });
  } catch {
    return null;
  }
  return tables;
}

/**
 * The module-level table bindings of a module (a top-level `const` holding an object literal,
 * `new Set([...])` or `new Map([...])`), each with the constructs that make row deletion refuse
 * it; an empty list is a table row deletion supports. The value-flow check (U10, value-flow/
 * sinks.ts) classifies a key read of exactly these tables as a supported table read. A name bound
 * to more than one table literal is `ambiguous`. Null when the module does not parse.
 */
export function scanSupportedTables(
  file: string,
  source: string,
): Map<string, (UnsupportedConstruct | 'ambiguous')[]> | null {
  let ast: t.File;
  try {
    ast = parseModule(source);
  } catch {
    return null;
  }
  return scanSupportedTablesIn(file, ast);
}

/**
 * {@link scanSupportedTables} over a module already parsed with the same options (`module`,
 * `typescript` and `decorators-legacy`), so a caller that parsed it does not parse it again.
 */
export function scanSupportedTablesIn(
  file: string,
  ast: t.File,
): Map<string, (UnsupportedConstruct | 'ambiguous')[]> | null {
  const tables = tablesIn(file, ast);
  if (tables === null) return null;
  const topLevel = new Set(
    ast.program.body.flatMap((statement) => {
      const declaration =
        t.isExportNamedDeclaration(statement) && statement.declaration !== null
          ? statement.declaration
          : statement;
      if (!t.isVariableDeclaration(declaration) || declaration.kind !== 'const') return [];
      return declaration.declarations.flatMap((declarator) =>
        t.isIdentifier(declarator.id) ? [declarator.id.name] : [],
      );
    }),
  );
  const out = new Map<string, (UnsupportedConstruct | 'ambiguous')[]>();
  for (const table of tables) {
    if (table.binding === null || !topLevel.has(table.binding)) continue;
    const constructs = [...table.unsupported].sort(byText);
    out.set(table.binding, out.has(table.binding) ? ['ambiguous'] : constructs);
  }
  return out;
}

// ── Plan ───────────────────────────────────────────────────────────────────

/** The end of an entry's splice: after its trailing comma, past whitespace and comments. */
function spliceEnd(source: string, end: number): number {
  let index = end;
  while (index < source.length) {
    if (/\s/.test(source[index])) index += 1;
    else if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index);
      index = newline === -1 ? source.length : newline;
    } else if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      if (close === -1) return end;
      index = close + 2;
    } else return source[index] === ',' ? index + 1 : end;
  }
  return end;
}

const parses = (source: string): boolean => {
  try {
    parseModule(source);
    return true;
  } catch {
    return false;
  }
};

/** A Babel location (1-based lines, 0-based columns) as a report span (1-based, end exclusive). */
const reportLocation = (loc: t.SourceLocation): ReportLocation => ({
  start: { line: loc.start.line, column: loc.start.column + 1 },
  end: { line: loc.end.line, column: loc.end.column + 1 },
});

type TableChoice =
  | { kind: 'none'; reason: 'no-common-table' | 'no-supported-table' }
  | { kind: 'problem'; reasons: string[] }
  | { kind: 'table'; table: ScannedTable };

const sameSet = (a: ReadonlySet<LiteralKey>, b: ReadonlySet<LiteralKey>): boolean =>
  a.size === b.size && [...a].every((value) => b.has(value));

/** What planning reads more than once across the pairs of one env. */
interface PlannerCache {
  sources: Map<string, string | null>;
  scans: Map<string, ScannedTable[] | null>;
  /** `contentHash` of each file's planning text. */
  fileHashes: Map<string, string>;
  /** Whether a file's planning text parses without a splice, by `<file>\0<start>\0<end>`. */
  splices: Map<string, boolean>;
}

/**
 * One cache per env: a run plans every pair over one env, so each file is read, scanned and
 * hashed once and each splice checked once. `env.read` returns the same text for a file
 * throughout (the run's checkout).
 */
const plannerCaches = new WeakMap<RowDeletionEnv, PlannerCache>();

class Planner {
  private readonly cache: PlannerCache;

  constructor(private readonly env: RowDeletionEnv) {
    let cache = plannerCaches.get(env);
    if (cache === undefined) {
      cache = { sources: new Map(), scans: new Map(), fileHashes: new Map(), splices: new Map() };
      plannerCaches.set(env, cache);
    }
    this.cache = cache;
  }

  source(file: string): string | null {
    const { sources } = this.cache;
    if (!sources.has(file)) sources.set(file, this.env.read(file));
    return sources.get(file) ?? null;
  }

  /** The text a file's deletions are planned on: its source, empty when it cannot be read. */
  text(file: string): string {
    return this.source(file) ?? '';
  }

  fileHash(file: string): string {
    const { fileHashes } = this.cache;
    let hash = fileHashes.get(file);
    if (hash === undefined) {
      hash = contentHash(this.text(file));
      fileHashes.set(file, hash);
    }
    return hash;
  }

  /** Whether the file's text still parses with `[start, end)` cut out. */
  spliceParses(file: string, start: number, end: number): boolean {
    const { splices } = this.cache;
    const key = `${file}\0${start}\0${end}`;
    let parsesCut = splices.get(key);
    if (parsesCut === undefined) {
      const text = this.text(file);
      parsesCut = parses(text.slice(0, start) + text.slice(end));
      splices.set(key, parsesCut);
    }
    return parsesCut;
  }

  private scan(file: string): ScannedTable[] | null {
    const { scans } = this.cache;
    if (!scans.has(file)) {
      const source = this.source(file);
      scans.set(file, source === null ? null : scanTables(file, source));
    }
    return scans.get(file) ?? null;
  }

  /** The one supported table holding both keys; see the module comment. */
  choose(search: TableSearch, a: LiteralKey, b: LiteralKey): TableChoice {
    for (const tier of [search.executed, search.closure]) {
      const matching = sortedUnique(tier).flatMap((file) => {
        const tables = this.env.tables
          .factsOf(file)
          .tables.filter((table) => table.values.has(a) && table.values.has(b));
        return tables.length === 0 ? [] : [{ file, tables }];
      });
      if (matching.length === 0) continue;
      const unparseable = matching.filter(({ file }) => this.scan(file) === null);
      if (unparseable.length > 0) return { kind: 'problem', reasons: ['unparseable'] };
      const candidates = matching.flatMap(({ file, tables }) =>
        (this.scan(file) ?? []).filter(
          (table) =>
            table.values.has(a) &&
            table.values.has(b) &&
            tables.some((indexed) => sameSet(indexed.values, table.values)),
        ),
      );
      if (candidates.length === 0) return { kind: 'none', reason: 'no-supported-table' };
      if (candidates.length > 1) return { kind: 'problem', reasons: ['ambiguous-table'] };
      const [table] = candidates;
      if (table.unsupported.size > 0) {
        return {
          kind: 'problem',
          reasons: sortedUnique([...table.unsupported].map((c) => `unsupported-table: ${c}`)),
        };
      }
      return { kind: 'table', table };
    }
    return { kind: 'none', reason: 'no-common-table' };
  }
}

const rowTableOf = (table: ScannedTable): RowTable => ({
  file: table.file,
  kind: table.kind,
  binding: table.binding,
  line: table.line,
});

/** The deletion of one key of a chosen table; null when its splice does not parse. */
function deletionOf(
  planner: Planner,
  table: ScannedTable,
  key: LiteralKey,
): PlannedDeletion | null {
  const node = table.entries.get(key);
  if (node === undefined || typeof node.start !== 'number' || typeof node.end !== 'number') {
    return null;
  }
  if (node.loc === null || node.loc === undefined) return null;
  const splice = { start: node.start, end: spliceEnd(planner.text(table.file), node.end) };
  if (!planner.spliceParses(table.file, splice.start, splice.end)) return null;
  const identity: MutantIdentity = {
    file: table.file,
    fileHash: planner.fileHash(table.file),
    location: reportLocation(node.loc),
    mutatorName: ROW_DELETION_MUTATOR,
    replacement: '',
  };
  return { globalId: formatGlobalId(identity), identity, key, table: rowTableOf(table), splice };
}

/** Plans the row deletions of one pair; see the module comment. Pure over `env`. */
export function planRowDeletion(input: RowDeletionPairInput, env: RowDeletionEnv): RowDeletionPlan {
  const planner = new Planner(env);
  const [facetA, facetB] = input.facets;
  const others = new Map(facetB.discarded.map((entry) => [entry.position, entry]));
  const positions: PositionPlan[] = [];
  const deletions = new Map<string, PlannedDeletion>();
  for (const entry of facetA.discarded) {
    const other = others.get(entry.position);
    if (other === undefined || other.kind !== entry.kind || other.value === entry.value) continue;
    const base = {
      position: entry.position,
      values: [entry.value, other.value] as [string, string],
    };
    const [keyA, keyB] = [tableKeyOf(entry), tableKeyOf(other)];
    const choice: TableChoice =
      keyA === null || keyB === null || keyA === keyB
        ? { kind: 'none', reason: 'no-common-table' }
        : planner.choose(input.search, keyA, keyB);
    if (choice.kind === 'none') {
      positions.push({ ...base, status: 'not-applicable', reasons: [choice.reason], table: null });
      continue;
    }
    if (choice.kind === 'problem') {
      positions.push({ ...base, status: 'inconclusive', reasons: choice.reasons, table: null });
      continue;
    }
    const { table } = choice;
    const planned = [keyA, keyB].map((key) =>
      key === null ? null : deletionOf(planner, table, key),
    );
    if (planned.some((deletion) => deletion === null)) {
      positions.push({
        ...base,
        status: 'inconclusive',
        reasons: ['splice-unparseable'],
        table: rowTableOf(table),
      });
      continue;
    }
    for (const deletion of planned)
      if (deletion !== null) deletions.set(deletion.globalId, deletion);
    positions.push({ ...base, status: 'planned', reasons: [], table: rowTableOf(table) });
  }
  const reasons = sortedUnique(positions.flatMap((position) => position.reasons));
  const status =
    deletions.size > 0
      ? 'planned'
      : positions.some((position) => position.status === 'inconclusive')
        ? 'inconclusive'
        : 'not-applicable';
  return {
    a: input.a,
    b: input.b,
    status,
    reasons: positions.length === 0 ? ['no-differing-values'] : reasons,
    positions,
    deletions: [...deletions.values()],
  };
}

// ── Classification ─────────────────────────────────────────────────────────

const USABLE: ReadonlySet<OutcomeClass> = new Set(['survived', 'killed-by-test:assertion']);

const allLoaded = (run: VitestRunResult, probeFiles: readonly string[]): boolean =>
  run.loadedFiles !== undefined && probeFiles.every((file) => run.loadedFiles?.includes(file));

/** The control run's problem: `control-failed`, `edit-not-loaded`, or null when it is usable. */
export function classifyControlRun(
  run: VitestRunResult,
  tests: readonly [string, string],
  probeFiles: readonly string[],
): 'control-failed' | 'edit-not-loaded' | null {
  const passed = tests.every(
    (id) => run.tests.find((test) => test.id === id)?.outcome === 'survived',
  );
  const clean =
    run.problems.length === 0 &&
    run.unhandledErrors.length === 0 &&
    run.status === 'survived' &&
    run.outsideTest.length === 0;
  if (!passed || !clean) return 'control-failed';
  return allLoaded(run, probeFiles) ? null : 'edit-not-loaded';
}

/** One deletion run's outcome; `reason` names why it is inconclusive. */
export function classifyDeletionRun(
  run: VitestRunResult,
  tests: readonly [string, string],
  probeFiles: readonly string[],
): { outcome: DeletionOutcome; reason: string | null } {
  const inconclusive = (reason: string) => ({ outcome: 'inconclusive' as const, reason });
  if (run.problems.length > 0 || run.status === 'error' || run.status === 'timeout') {
    return inconclusive(run.outcome);
  }
  const outside = run.outsideTest[0];
  if (outside !== undefined) return inconclusive(outside.outcome);
  const outcomes = tests.map((id) => run.tests.find((test) => test.id === id)?.outcome ?? null);
  const unusable = outcomes.find((outcome) => outcome === null || !USABLE.has(outcome));
  if (unusable !== undefined) return inconclusive(unusable ?? 'missing');
  if (!allLoaded(run, probeFiles)) return inconclusive('edit-not-loaded');
  const failing = outcomes.filter((outcome) => outcome === 'killed-by-test:assertion').length;
  return { outcome: failing === 1 ? 'asymmetric' : 'symmetric', reason: null };
}

/** The pair outcome over its deletions and unplanned positions; see the module comment. */
export function combineRowDeletion(outcomes: readonly RowDeletionOutcome[]): RowDeletionOutcome {
  if (outcomes.includes('asymmetric')) return 'asymmetric';
  if (outcomes.includes('inconclusive')) return 'inconclusive';
  if (outcomes.includes('symmetric')) return 'symmetric';
  return 'not-applicable';
}

// ── Runs ───────────────────────────────────────────────────────────────────

export interface RunSummary {
  outcome: OutcomeClass;
  /** Each test's outcome class, in pair order; null when it has no row. */
  tests: { id: string; outcome: OutcomeClass | null; message: string | null }[];
  loadedFiles: string[] | null;
  problems: string[];
  wallClockMs: number;
}

export interface DeletionResult {
  globalId: string;
  key: LiteralKey;
  table: RowTable;
  outcome: DeletionOutcome;
  /** Why the deletion is inconclusive; null otherwise. */
  reason: string | null;
  run: RunSummary | null;
}

export interface RowDeletionResult {
  a: string;
  b: string;
  outcome: RowDeletionOutcome;
  /** Why the pair is inconclusive or not applicable, sorted and distinct. */
  reasons: string[];
  /** Error text of a run that threw or of a mismatching copy; null otherwise. */
  detail: string | null;
  positions: PositionPlan[];
  control: RunSummary | null;
  deletions: DeletionResult[];
  wallClockMs: number;
}

export interface RowDeletionDeps {
  runVitest: (options: VitestRunOptions) => Promise<VitestRunResult>;
  prepare: (options: PrepareOptions) => PrepareReport;
  /** Milliseconds on a monotonic clock. */
  now: () => number;
}

export const defaultRowDeletionDeps: RowDeletionDeps = {
  runVitest,
  prepare,
  now: () => performance.now(),
};

export interface RowDeletionRunOptions {
  /** Absolute repo checkout. */
  repoRoot: string;
  /** Absolute work directory, outside the checkout. */
  workDir: string;
  /** The run manifest the copy is verified against. */
  manifest: ScenarioRunManifest;
  plans: readonly RowDeletionPlan[];
  /** Upper bound of each Vitest run's worker processes (the CLI's `--concurrency`). */
  maxWorkers?: number;
}

const summarize = (run: VitestRunResult, tests: readonly string[]): RunSummary => ({
  outcome: run.outcome,
  tests: tests.map((id) => {
    const test = run.tests.find((entry) => entry.id === id);
    return { id, outcome: test?.outcome ?? null, message: test?.message ?? null };
  }),
  loadedFiles: run.loadedFiles ?? null,
  problems: [...run.problems, ...run.unhandledErrors],
  wallClockMs: run.wallClockMs,
});

/** `<work>/row-deletion/pairs/<16 hex digits of sha256 over the two ids>`. */
const pairDir = (workDir: string, plan: RowDeletionPlan): string =>
  path.join(workDir, 'row-deletion', 'pairs', sha256(`${plan.a}\n${plan.b}`).slice(0, 16));

interface Copy {
  preparedRoot: string;
  packageDir: string;
  /** Prepared-root path of each repo path. */
  preparedPathOf: (repoPath: string) => string;
  /** The manifest check's mismatches; empty when the copy is verified. */
  mismatches: string[];
}

interface Finish {
  reasons: string[];
  detail: string | null;
  control: RunSummary | null;
  deletions: DeletionResult[];
}

function resultOf(plan: RowDeletionPlan, finish: Finish, wallClockMs: number): RowDeletionResult {
  const outcomes: RowDeletionOutcome[] = [
    ...plan.positions.map(
      (position): RowDeletionOutcome =>
        position.status === 'planned' ? 'not-applicable' : position.status,
    ),
    ...finish.deletions.map((deletion) => deletion.outcome),
  ];
  const outcome = plan.positions.length === 0 ? 'not-applicable' : combineRowDeletion(outcomes);
  const reasons = sortedUnique([
    ...plan.reasons,
    ...finish.reasons,
    ...finish.deletions.flatMap((deletion) =>
      deletion.reason === null || finish.reasons.includes(deletion.reason)
        ? []
        : [`deletion: ${deletion.reason}`],
    ),
  ]);
  return {
    a: plan.a,
    b: plan.b,
    outcome,
    reasons: outcome === 'asymmetric' ? [] : reasons,
    detail: finish.detail,
    positions: plan.positions,
    control: finish.control,
    deletions: finish.deletions,
    wallClockMs,
  };
}

/** Every planned deletion inconclusive for one reason, none run. */
const skipped = (
  plan: RowDeletionPlan,
  reason: string,
  detail: string | null,
  control: RunSummary | null = null,
): Finish => ({
  reasons: [reason],
  detail,
  control,
  deletions: plan.deletions.map((deletion) => ({
    globalId: deletion.globalId,
    key: deletion.key,
    table: deletion.table,
    outcome: 'inconclusive',
    reason,
    run: null,
  })),
});

/** The control run and one run per deletion of one planned pair, in the verified copy. */
async function runPlan(
  plan: RowDeletionPlan,
  copy: Copy,
  options: Pick<RowDeletionRunOptions, 'manifest' | 'workDir' | 'maxWorkers'>,
  deps: RowDeletionDeps,
): Promise<Finish> {
  const { manifest, workDir, maxWorkers } = options;
  if (copy.mismatches.length > 0) {
    return skipped(plan, 'manifest-mismatch', copy.mismatches.join('; '));
  }
  const tests: [string, string] = [plan.a, plan.b];
  const listed = new Set(manifest.tests.map((test) => test.id));
  const unlisted = tests.filter((test) => !listed.has(test));
  if (unlisted.length > 0) {
    return skipped(plan, 'manifest-mismatch', `not in the run manifest: ${unlisted.join(', ')}`);
  }

  const files = new Map<string, { absolute: string; packagePath: string; original: string }>();
  for (const deletion of plan.deletions) {
    const file = deletion.identity.file;
    if (files.has(file)) continue;
    const prepared = copy.preparedPathOf(file);
    const absolute = path.join(copy.preparedRoot, prepared);
    let original: string;
    try {
      original = readFileSync(absolute, 'utf8');
    } catch (error) {
      return skipped(plan, 'copy-mismatch', `${prepared}: ${errorMessage(error)}`);
    }
    if (contentHash(original) !== deletion.identity.fileHash) {
      return skipped(plan, 'copy-mismatch', `${prepared} differs from the planned ${file}`);
    }
    files.set(file, { absolute, packagePath: prepared.slice(PACKAGE_DIR.length + 1), original });
  }

  const dir = pairDir(workDir, plan);
  // Scratch of an earlier run (a Vite cache among it) would leak into this one.
  rmSync(dir, { recursive: true, force: true });
  const vitest = vitestSelectionOf(manifest.mode);
  const run = (name: string, probeFiles: string[]): Promise<VitestRunResult> =>
    deps.runVitest({
      packageDir: copy.packageDir,
      testIds: tests,
      vitest,
      workDir: path.join(dir, name),
      probeFiles,
      maxWorkers,
    });

  const probeFiles = [...files.values()].map((file) => file.packagePath);
  let control: VitestRunResult;
  try {
    control = await run('control', probeFiles);
  } catch (error) {
    return skipped(plan, 'control-failed', errorMessage(error));
  }
  const problem = classifyControlRun(control, tests, probeFiles);
  if (problem !== null) {
    return skipped(plan, problem, control.reason, summarize(control, tests));
  }

  const deletions: DeletionResult[] = [];
  let detail: string | null = null;
  for (const [index, deletion] of plan.deletions.entries()) {
    const file = files.get(deletion.identity.file);
    if (file === undefined) throw new Error(`row deletion: ${deletion.identity.file} not read`);
    const { start, end } = deletion.splice;
    const base = { globalId: deletion.globalId, key: deletion.key, table: deletion.table };
    writeFileSync(file.absolute, file.original.slice(0, start) + file.original.slice(end));
    try {
      const result = await run(`deletion-${index + 1}`, [file.packagePath]);
      deletions.push({
        ...base,
        ...classifyDeletionRun(result, tests, [file.packagePath]),
        run: summarize(result, tests),
      });
    } catch (error) {
      deletions.push({ ...base, outcome: 'inconclusive', reason: 'run-error', run: null });
      detail ??= errorMessage(error);
    } finally {
      writeFileSync(file.absolute, file.original);
    }
  }
  return { reasons: [], detail, control: summarize(control, tests), deletions };
}

/**
 * Runs the planned row deletions of a batch of pairs in one throwaway copy; see the module
 * comment. Plans without deletions come back as they are, and no copy is made for them.
 */
export async function runRowDeletion(
  options: RowDeletionRunOptions,
  deps: RowDeletionDeps = defaultRowDeletionDeps,
): Promise<RowDeletionResult[]> {
  const { repoRoot, workDir, manifest, plans } = options;
  if (overlaps(repoRoot, workDir)) {
    throw new Error(`row deletion: the work directory ${workDir} must lie outside ${repoRoot}`);
  }
  let copy: Copy | null = null;
  const results: RowDeletionResult[] = [];
  for (const plan of plans) {
    const started = deps.now();
    if (plan.deletions.length === 0) {
      results.push(resultOf(plan, { reasons: [], detail: null, control: null, deletions: [] }, 0));
      continue;
    }
    if (copy === null) {
      const preparedRoot = path.join(workDir, 'row-deletion', 'prepared');
      const pathMap = buildPathMap(extraRootsOf(manifest.mode));
      deps.prepare({ repoRoot, outDir: preparedRoot, mutate: [], pathMap });
      copy = {
        preparedRoot,
        packageDir: path.join(preparedRoot, PACKAGE_DIR),
        preparedPathOf: (repoPath) => toPreparedPath(repoPath, pathMap),
        mismatches: verifyPreparedCopy(manifest, preparedRoot).mismatches,
      };
    }
    const finish = await runPlan(plan, copy, options, deps);
    results.push(resultOf(plan, finish, Math.round(deps.now() - started)));
  }
  return results;
}
