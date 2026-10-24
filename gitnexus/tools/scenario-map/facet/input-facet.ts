/**
 * Input facet of a test instance for the scenario map (Layer 2, U6, R5, R9, KTD6, design §2
 * "Input facet", §5.3 rules 1–8), ported from the input-facet spike
 * (`gitnexus/spike-input-facet.mts`, untracked) and its rule 6 (`analyze-slice.mjs`).
 *
 * The facet is a signature of what one runtime instance feeds the code. Its slots are the test
 * body's string, template, numeric and bigint literals, and the values its row binds (an
 * `it.each` / `test.for` row, the innermost `for…of` element, through checks.ts `rowValueOf`)
 * where the body reads them, in source order. Each slot becomes one token:
 *  - rule 1 / rule 2: a string that looks like code in the language the test names is replaced
 *    by its anonymised tree shape (source-shape.ts), COBOL by its reserved words;
 *  - rule 4: a literal the checks keep exact as a selector of an `expect(...)` subject (checks.ts
 *    `abstractNode` decides) stays exact, `SEL:<text>` (`SEL#<number>`);
 *  - rule 3 / D2: numbers `0`, `1`, `-1` and negatives stay exact (`#=<text>`), as does a number
 *    within ±1 of a numeric constant of the test's executed production files or of its static
 *    import closure (KTD6, tables.ts); strings and other numbers map to their best-fit production
 *    table (`T:<id>`: executed files, then two import hops, then property columns, never pooled),
 *    a synthetic file path to its extension's table, anything else to its boundary-aware shape
 *    (`''`, `'0'`, `'1'`, `'-1'` keep their value);
 *  - rule 7: a describe whose `beforeAll` / `beforeEach` names a fixture directory resolves the
 *    test's literals (and the words inside them) against that directory's definitions: the
 *    definition's shape, its referenced types with their bases and field types (the declaration
 *    kind for presence-only assertions); resolved literals leave the data part;
 *  - rule 8: a literal naming one fixture file contributes that file's shape.
 * Rule 5 adds the key set of every object literal (and object row value); rule 6 adds the called
 * function names (assertions left out) and the slot shapes in source order.
 *
 * Every slot not kept exact is a discarded value, recorded with its position (slot index), its
 * value and its source location for the value-flow check (U10, R9). `unresolved` lists why the
 * facet may not stand for the instance (a row value that is not static, a free name under an
 * untracked outer row, unknown provenance or import closure, a fixture file that cannot be
 * shaped); it blocks strong evidence.
 *
 * Residual-difference guard (R5, KTD6, D1): {@link residualDifference} diffs the anonymised body
 * skeletons of two facet-equal instances (slots and row reads as placeholders, body locals
 * renamed). Any other differing node (an enum member, a regex, a boolean or `null`, an operator)
 * makes the pair facet-unequal for the verdict engine; {@link applyResidualGuard} also marks both
 * instances unresolved.
 *
 * Library only; the scenario-map CLI (U14) builds one context per run
 * ({@link createRunFacetContext}, or {@link createFacetContext} with in-memory sources) and calls
 * {@link computeFacet} per inventory instance ({@link facetSubjectOf}).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generate } from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { SupportedLanguages } from 'gitnexus-shared';
import { classify } from '../../mutation/classify/classify.js';
import type { CaseRecord } from '../../test-dupes/test-dupes.js';
import {
  normalizeRelativePath,
  productionFilePredicate,
  productionRoots,
  type InventoryInstance,
  type RowValue,
  type StaticInstance,
} from '../types.js';
import { abstractNode, buildScope, rowValueOf, SUPPORTED_MATCHERS, type Scope } from './checks.js';
import {
  cobolWords,
  FixtureIndex,
  languageOf,
  looksLikeSource,
  PATHLIKE,
  shapeText,
  SourceShaper,
  type SourceReader,
} from './source-shape.js';
import { nearConstant, numberKey, stringKey, TableIndex, type LiteralKey } from './tables.js';

/** Default fixture root (rules 7 and 8). */
export const FIXTURE_ROOT = 'gitnexus/test/fixtures';
/** Language providers whose string tables name GitNexus builtins (rule 1). */
export const BUILTINS_DIR = 'gitnexus/src/core/ingestion/languages';
/** Import hops of the second table tier (design §5.3 rule 3). */
const TABLE_HOPS = 2;

/** Body text that marks presence-only assertions (rule 7, the spike's GitNexus heuristic). */
const PRESENCE_QUERY = /getNodesByLabel/;
const RELATION_QUERY = /getRelationships|CALLS|ACCESSES|EXTENDS|IMPLEMENTS|HAS_METHOD|IMPORTS/;
/** Called names that are assertion plumbing, not builders (rule 6). */
const ASSERTION_NAMES: ReadonlySet<string> = new Set([
  'expect',
  'it',
  'test',
  'describe',
  'suite',
  'not',
  'resolves',
  'rejects',
  'soft',
  'assertions',
  'hasAssertions',
  ...SUPPORTED_MATCHERS,
]);
const TS_EXPRESSIONS: ReadonlySet<string> = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
]);
/** Child keys holding types only; they never run, so the skeleton leaves them out. */
const TYPE_KEYS: ReadonlySet<string> = new Set([
  'typeAnnotation',
  'returnType',
  'typeParameters',
  'typeArguments',
  'superTypeParameters',
  'implements',
]);
/** Node fields the skeleton never compares: positions, comments, formatting. */
const SKIPPED_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'start',
  'end',
  'loc',
  'range',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'errors',
  'tokens',
  'shorthand',
]);

// ── Public shapes ──────────────────────────────────────────────────────────

/** Repo-path file access of one run. */
export type FacetSources = SourceReader;

export interface FacetContextOptions {
  sources: FacetSources;
  /** Extra path-map roots of the run mode (types.ts `extraRootsOf`). */
  extraRoots?: readonly string[];
  /** Production files of the run (repo paths): the property-column universe. */
  productionFiles: readonly string[];
  /**
   * Static import closure per test file (package path → repo paths, test file included):
   * classify's `FileVerdict.closure`.
   */
  closures: ReadonlyMap<string, readonly string[]>;
  /** Files whose string tables are GitNexus builtin names; default every file of {@link BUILTINS_DIR}. */
  builtinFiles?: readonly string[];
  /** Repo path of the fixture tree; default {@link FIXTURE_ROOT}. */
  fixtureRoot?: string;
}

/** One test instance. */
export interface FacetSubject {
  /** Phase 0 test id. */
  id: string;
  /** Package path of the test file. */
  file: string;
  record: CaseRecord;
  /** The joined static instance; null when not known. */
  instance: StaticInstance | null;
  /** Files the test executed (Layer 1 provenance, repo paths); null when not known. */
  executedFiles: readonly string[] | null;
}

export interface SourceLocation {
  /** Repo path of the test file. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 0-based column (Babel). */
  column: number;
}

/** A concrete value the facet dropped (design §2, §5.3a). */
export interface DiscardedValue {
  /** Slot index in source order; equal facets have the same slots. */
  position: number;
  kind: 'string' | 'number' | 'bigint';
  /** The string itself, or the number's text. */
  value: string;
  /** Where the body writes the literal, or reads the row value. */
  location: SourceLocation;
  origin: 'literal' | 'row';
}

export interface FacetParts {
  /** The language of the inline source, or `-` when no source or fixture part exists. */
  language: string;
  /** Rule 1 / rule 2: source profiles, sorted, distinct. */
  source: string[];
  /** Rules 7 / 8: fixture elements, sorted, distinct. */
  fixtures: string[];
  /** Rules 3 / 4 / 5: data tokens and object key sets, sorted. */
  data: string[];
  /** Rule 6: called function names in source order. */
  calls: string[];
  /** Rule 6: slot shapes in source order. */
  order: string[];
}

export interface InputFacet {
  /** sha1 over the parts; equal facets have equal fingerprints. */
  fingerprint: string;
  parts: FacetParts;
  discarded: DiscardedValue[];
  /** Sorted reasons; non-empty blocks strong evidence. */
  unresolved: string[];
  /** `<node path>\t<token>` lines of the anonymised body, for {@link residualDifference}. */
  skeleton: string[];
}

/** One node that differs between two facet-equal instances; null when the node is absent. */
export interface ResidualDifference {
  path: string;
  a: string | null;
  b: string | null;
}

// ── Context ────────────────────────────────────────────────────────────────

export interface ClosureFiles {
  /** Production files of the whole closure (constants). */
  all: string[];
  /** Production files within {@link TABLE_HOPS} hops (second table tier). */
  near: string[];
}

/** Shared state of one run: production tables and constants, parsers, the fixture tree. */
export class FacetContext {
  readonly tables: TableIndex;
  readonly shaper: SourceShaper;
  readonly isProduction: (repoPath: string) => boolean;
  private fixtureIndex: FixtureIndex | null = null;
  private builtinNames: ReadonlySet<string> | null = null;
  private readonly closureFiles = new Map<string, ClosureFiles | null>();

  constructor(private readonly options: FacetContextOptions) {
    this.isProduction = productionFilePredicate(options.extraRoots ?? []);
    this.tables = new TableIndex({
      read: (file) => options.sources.read(file),
      columnFiles: options.productionFiles,
    });
    this.shaper = new SourceShaper(options.sources, () => this.builtins());
  }

  /** GitNexus builtin names (rule 1), read on first use. */
  builtins(): ReadonlySet<string> {
    if (this.builtinNames === null) {
      const files =
        this.options.builtinFiles ??
        this.options.sources
          .list(BUILTINS_DIR)
          .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
      this.builtinNames = this.tables.stringValues(files);
    }
    return this.builtinNames;
  }

  /** The fixture tree (rules 7, 8), listed on first use. */
  fixtures(): FixtureIndex {
    if (this.fixtureIndex === null) {
      const root = this.options.fixtureRoot ?? FIXTURE_ROOT;
      this.fixtureIndex = new FixtureIndex(root, this.options.sources.list(root));
    }
    return this.fixtureIndex;
  }

  /** The production files of a test file's static import closure; null when not known. */
  closureOf(subject: FacetSubject): ClosureFiles | null {
    if (this.closureFiles.has(subject.file)) return this.closureFiles.get(subject.file) ?? null;
    const closure = this.options.closures.get(subject.file);
    let files: ClosureFiles | null = null;
    if (closure !== undefined) {
      const hops = importHops(subject.record.file, closure, this.options.sources, TABLE_HOPS);
      const all = closure.filter((file) => this.isProduction(file)).sort();
      files = { all, near: all.filter((file) => (hops.get(file) ?? Infinity) <= TABLE_HOPS) };
    }
    this.closureFiles.set(subject.file, files);
    return files;
  }
}

export const createFacetContext = (options: FacetContextOptions): FacetContext =>
  new FacetContext(options);

/** File access under a checkout root; paths that escape it read null. */
export function fsFacetSources(repoRoot: string): FacetSources {
  const resolve = (repoPath: string): string | null => {
    try {
      return path.join(repoRoot, normalizeRelativePath(repoPath));
    } catch {
      return null;
    }
  };
  return {
    read(repoPath) {
      const file = resolve(repoPath);
      if (file === null) return null;
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    list(repoDir) {
      const out: string[] = [];
      const walk = (relative: string): void => {
        const dir = resolve(relative);
        if (dir === null) return;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const child = `${relative}/${entry.name}`;
          if (entry.isDirectory() && entry.name !== 'node_modules') walk(child);
          else if (entry.isFile()) out.push(child);
        }
      };
      walk(repoDir.replace(/\/+$/, ''));
      return out.sort();
    },
  };
}

export interface RunFacetOptions {
  repoRoot: string;
  /** Extra path-map roots of the run mode; non-empty in controls mode. */
  extraRoots: readonly string[];
  /** Package paths of the run's test files. */
  testFiles: readonly string[];
}

/**
 * The facet context of a run over a checkout: closures from the classifier, and as production
 * universe every production file of the mode (in controls mode, the fixture project only).
 */
export function createRunFacetContext(options: RunFacetOptions): FacetContext {
  const sources = fsFacetSources(options.repoRoot);
  const verdicts = classify({ repoRoot: options.repoRoot, testFiles: options.testFiles }).files;
  const closures = new Map(verdicts.map((verdict) => [verdict.file, verdict.closure]));
  const isProduction = productionFilePredicate(options.extraRoots);
  const base = new Set(productionRoots());
  const roots =
    options.extraRoots.length > 0
      ? productionRoots(options.extraRoots).filter((root) => !base.has(root))
      : productionRoots();
  const productionFiles = roots.flatMap((root) => sources.list(root)).filter(isProduction);
  return createFacetContext({
    sources,
    extraRoots: options.extraRoots,
    productionFiles,
    closures,
  });
}

/** The facet subject of an inventory instance; null without a call site. */
export function facetSubjectOf(
  instance: InventoryInstance,
  provenance: { known: boolean; executedFiles: readonly string[] } | null,
): FacetSubject | null {
  if (instance.site === null) return null;
  return {
    id: instance.id,
    file: instance.file,
    record: instance.site.record,
    instance: instance.instance,
    executedFiles: provenance !== null && provenance.known ? provenance.executedFiles : null,
  };
}

// ── Static import hops ─────────────────────────────────────────────────────

const RESOLVE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '/index.ts',
  '/index.js',
];

/** The module specifiers a source imports or re-exports at run time. */
function specifiersOf(source: string): string[] {
  let ast: t.File;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx', 'decorators-legacy'],
      errorRecovery: true,
    });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const statement of ast.program.body) {
    if (t.isImportDeclaration(statement) && statement.importKind !== 'type') {
      out.push(statement.source.value);
    } else if (
      (t.isExportNamedDeclaration(statement) || t.isExportAllDeclaration(statement)) &&
      statement.source &&
      statement.exportKind !== 'type'
    ) {
      out.push(statement.source.value);
    }
  }
  t.traverseFast(ast, (node) => {
    if (!t.isCallExpression(node) || !t.isStringLiteral(node.arguments[0])) return;
    if (t.isImport(node.callee) || t.isIdentifier(node.callee, { name: 'require' })) {
      out.push(node.arguments[0].value);
    }
  });
  return out;
}

/** The closure member a specifier names, else null. */
function resolveIn(from: string, specifier: string, members: ReadonlySet<string>): string | null {
  let base: string;
  if (specifier.startsWith('.'))
    base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  else if (specifier === 'gitnexus-shared') base = 'gitnexus-shared/src/index';
  else if (specifier.startsWith('gitnexus-shared/')) {
    base = `gitnexus-shared/src/${specifier.slice('gitnexus-shared/'.length).replace(/^(dist|src)\//, '')}`;
  } else return null;
  const stem = base.replace(/\.[mc]?[jt]sx?$/, '');
  for (const candidate of [base, ...RESOLVE_SUFFIXES.map((suffix) => `${stem}${suffix}`)]) {
    if (members.has(candidate)) return candidate;
  }
  return null;
}

/** Import hops from the test file to each closure member, up to `limit`. */
export function importHops(
  testFile: string,
  closure: readonly string[],
  sources: FacetSources,
  limit: number,
): Map<string, number> {
  const members = new Set(closure);
  const hops = new Map<string, number>([[testFile, 0]]);
  const queue = [testFile];
  for (let index = 0; index < queue.length; index++) {
    const module = queue[index];
    const depth = hops.get(module) ?? 0;
    if (depth >= limit) continue;
    const source = sources.read(module);
    if (source === null) continue;
    for (const specifier of specifiersOf(source)) {
      const target = resolveIn(module, specifier, members);
      if (target === null || hops.has(target)) continue;
      hops.set(target, depth + 1);
      queue.push(target);
    }
  }
  return hops;
}

// ── Slots ──────────────────────────────────────────────────────────────────

interface Slot {
  kind: DiscardedValue['kind'];
  value: string;
  /** The number, for numeric slots. */
  number: number | null;
  /** Where the body writes or reads it. */
  node: t.Node;
  origin: DiscardedValue['origin'];
  /** A selector of an expect subject (rule 4). */
  selector: boolean;
}

interface Collected {
  slots: Slot[];
  /** Rule 5 key sets. */
  keys: string[];
  /** Skeleton tokens of slot and row-read nodes. */
  placeholders: Map<t.Node, string>;
}

const gen = (node: t.Node): string => generate(node, { comments: false, compact: true }).code;
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

function unwrap(node: t.Node): t.Node {
  let n = node;
  while (TS_EXPRESSIONS.has(n.type) || t.isParenthesizedExpression(n)) {
    n = (n as t.TSAsExpression).expression;
  }
  return n;
}

const isTypeNode = (node: t.Node): boolean =>
  node.type.startsWith('TS') && !TS_EXPRESSIONS.has(node.type);

/** A literal the checks render as a whole: a string, a plain template, a (negated) number. */
function isLiteralSlot(node: t.Node): boolean {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBigIntLiteral(node)) return true;
  if (t.isTemplateLiteral(node)) return node.expressions.length === 0;
  return (
    t.isUnaryExpression(node, { operator: '-' }) &&
    (t.isNumericLiteral(node.argument) || t.isBigIntLiteral(node.argument))
  );
}

const isPlaceholder = (node: t.Node): boolean => t.isIdentifier(node) && /^<.*>$/.test(node.name);

function hasPlaceholder(node: t.Node): boolean {
  let found = isPlaceholder(node);
  t.traverseFast(node, (n) => {
    if (isPlaceholder(n)) found = true;
  });
  return found;
}

const isNode = (value: unknown): value is t.Node =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string';

/** The subject of an `expect(x)` / `expect.soft(x)` call, else null. */
function expectSubject(call: t.CallExpression): t.Node | null {
  const callee = call.callee;
  const isExpect =
    t.isIdentifier(callee, { name: 'expect' }) ||
    (t.isMemberExpression(callee) &&
      t.isIdentifier(callee.object, { name: 'expect' }) &&
      t.isIdentifier(callee.property, { name: 'soft' }));
  const subject = call.arguments[0];
  return isExpect && subject !== undefined && !t.isSpreadElement(subject) ? subject : null;
}

/**
 * Rule 4 through checks.ts: the literal and row-read nodes of the expect subjects that
 * `abstractNode` renders exact (selectors). The original subject is walked alongside its
 * abstracted copy; a literal kept as a literal (not a `<kind>` placeholder) is a selector.
 */
function selectorNodes(body: t.Node, scope: Scope): Set<t.Node> {
  const exact = new Set<t.Node>();
  const pair = (original: t.Node, abstracted: t.Node): void => {
    if (isLiteralSlot(original)) {
      if (!isPlaceholder(abstracted)) exact.add(original);
      return;
    }
    if (t.isTemplateLiteral(original)) {
      if (t.isTemplateLiteral(abstracted) && abstracted.quasis === original.quasis) {
        exact.add(original);
      }
    } else if (
      (t.isIdentifier(original) ||
        t.isMemberExpression(original) ||
        t.isOptionalMemberExpression(original)) &&
      rowValueOf(original, scope) !== null
    ) {
      if (!hasPlaceholder(abstracted)) exact.add(original);
      return;
    }
    if (original.type !== abstracted.type) return;
    for (const key of t.VISITOR_KEYS[original.type] ?? []) {
      if (key === 'key' && (original as { computed?: unknown }).computed !== true) continue;
      const left: unknown = (original as unknown as Record<string, unknown>)[key];
      const right: unknown = (abstracted as unknown as Record<string, unknown>)[key];
      if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
        left.forEach((item: unknown, index) => {
          const other: unknown = right[index];
          if (isNode(item) && isNode(other)) pair(item, other);
        });
      } else if (isNode(left) && isNode(right)) pair(left, right);
    }
  };
  t.traverseFast(body, (node) => {
    if (!t.isCallExpression(node)) return;
    const subject = expectSubject(node);
    if (subject !== null) pair(subject, abstractNode(subject, scope, true, false));
  });
  return exact;
}

const numberText = (value: number): string => (Object.is(value, -0) ? '-0' : String(value));

/** Skeleton text of a row value: slot kinds as `<slot>`, everything else exact. */
function rowSkeleton(value: RowValue): string {
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'bigint':
      return '<slot>';
    case 'boolean':
      return String(value.value);
    case 'null':
    case 'undefined':
      return value.kind;
    case 'regexp':
      return `/${value.pattern}/${value.flags}`;
    case 'array':
      return `[${value.items.map(rowSkeleton).join(',')}]`;
    case 'object':
      return `{${value.entries.map((entry) => `${JSON.stringify(entry.key)}:${rowSkeleton(entry.value)}`).join(',')}}`;
    case 'unresolved':
      return '?';
  }
}

function objectKeys(node: t.ObjectExpression): string {
  const keys = node.properties.map((property) => {
    if (!t.isObjectProperty(property) || property.computed) return '…';
    if (t.isIdentifier(property.key)) return property.key.name;
    if (t.isStringLiteral(property.key)) return property.key.value;
    return '…';
  });
  return `K{${keys.sort().join(',')}}`;
}

/** The slots of the body in source order, with key sets and skeleton placeholders. */
function collectSlots(
  record: CaseRecord,
  scope: Scope,
  selectors: ReadonlySet<t.Node>,
  unresolved: Set<string>,
): Collected {
  const found: { start: number; seq: number; slot: Slot }[] = [];
  const keys: string[] = [];
  const placeholders = new Map<t.Node, string>();
  let seq = 0;
  const push = (node: t.Node, slot: Omit<Slot, 'node' | 'selector'>, at: t.Node): void => {
    found.push({
      start: at.start ?? 0,
      seq: seq++,
      slot: { ...slot, node, selector: selectors.has(at) },
    });
  };
  const pushRow = (value: RowValue, at: t.Node, code: string): void => {
    switch (value.kind) {
      case 'string':
        push(at, { kind: 'string', value: value.value, number: null, origin: 'row' }, at);
        return;
      case 'number':
        push(
          at,
          { kind: 'number', value: value.text, number: Number(value.text), origin: 'row' },
          at,
        );
        return;
      case 'bigint':
        push(at, { kind: 'bigint', value: value.text, number: null, origin: 'row' }, at);
        return;
      case 'array':
        for (const item of value.items) pushRow(item, at, code);
        return;
      case 'object':
        keys.push(
          `K{${value.entries
            .map((entry) => entry.key)
            .sort()
            .join(',')}}`,
        );
        for (const entry of value.entries) pushRow(entry.value, at, code);
        return;
      case 'unresolved':
        unresolved.add(`row value ${code}: ${value.reason}`);
        return;
      default:
        return;
    }
  };
  const walk = (node: t.Node | null | undefined): void => {
    if (!isNode(node) || isTypeNode(node)) return;
    if (t.isIdentifier(node) || t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      const row = rowValueOf(node, scope);
      // `name.trim()`, `row[i]`: the read itself is not static but its object is, so the object
      // is the input and the member access is code.
      const objectRow = t.isIdentifier(node) ? null : rowValueOf(node.object, scope);
      const throughObject = row === 'unknown' && objectRow !== null && objectRow !== 'unknown';
      if (row !== null && !throughObject) {
        const code = gen(node);
        if (row === 'unknown') {
          unresolved.add(`row value ${code}: not static`);
          placeholders.set(node, '<row:?>');
        } else {
          pushRow(row, node, code);
          placeholders.set(node, `<row:${rowSkeleton(row)}>`);
        }
        return;
      }
    }
    if (t.isStringLiteral(node)) {
      push(node, { kind: 'string', value: node.value, number: null, origin: 'literal' }, node);
      placeholders.set(node, '<slot>');
      return;
    }
    if (t.isTemplateLiteral(node)) {
      const text = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('__X__');
      push(node, { kind: 'string', value: text, number: null, origin: 'literal' }, node);
      placeholders.set(node, '<slot>');
      node.expressions.forEach(walk);
      return;
    }
    const negated = t.isUnaryExpression(node, { operator: '-' });
    const numeric = negated ? node.argument : node;
    if (t.isNumericLiteral(numeric)) {
      const value = negated ? -numeric.value : numeric.value;
      push(
        node,
        { kind: 'number', value: numberText(value), number: value, origin: 'literal' },
        node,
      );
      placeholders.set(node, '<slot>');
      return;
    }
    if (t.isBigIntLiteral(numeric)) {
      const text = `${negated ? '-' : ''}${numeric.value}`;
      push(node, { kind: 'bigint', value: text, number: null, origin: 'literal' }, node);
      placeholders.set(node, '<slot>');
      return;
    }
    if (t.isObjectExpression(node)) keys.push(objectKeys(node));
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      if (TYPE_KEYS.has(key) || key === 'label') continue;
      if (key === 'key' && (node as { computed?: unknown }).computed !== true) continue;
      if (
        key === 'property' &&
        (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
        !node.computed
      ) {
        continue;
      }
      const value: unknown = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) for (const item of value) walk(isNode(item) ? item : null);
      else walk(isNode(value) ? value : null);
    }
  };
  walk(record.fn.body);
  found.sort((a, b) => a.start - b.start || a.seq - b.seq);
  return { slots: found.map((entry) => entry.slot), keys, placeholders };
}

// ── Rule 6: builder calls ──────────────────────────────────────────────────

function calledNames(body: t.Node, scope: Scope): string[] {
  const calls: { start: number; name: string }[] = [];
  t.traverseFast(body, (node) => {
    if (
      !t.isCallExpression(node) &&
      !t.isOptionalCallExpression(node) &&
      !t.isNewExpression(node)
    ) {
      return;
    }
    const callee = unwrap(node.callee);
    let name: string | null = null;
    if (t.isIdentifier(callee)) name = scope.locals.has(callee.name) ? '<local>' : callee.name;
    else if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
      if (!callee.computed && t.isIdentifier(callee.property)) name = callee.property.name;
      else if (t.isStringLiteral(callee.property)) name = callee.property.value;
    }
    if (name !== null && !ASSERTION_NAMES.has(name)) calls.push({ start: node.start ?? 0, name });
  });
  return calls.sort((a, b) => a.start - b.start).map((call) => call.name);
}

// ── Skeleton (residual-difference guard) ───────────────────────────────────

function attributesOf(node: t.Node): string {
  const visitorKeys = new Set(t.VISITOR_KEYS[node.type] ?? []);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_FIELDS.has(key) || visitorKeys.has(key)) continue;
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.length > 0 ? `{${parts.sort().join(',')}}` : '';
}

/** `<path>\t<token>` lines of the params and body, slots and row reads as placeholders. */
function skeletonOf(
  record: CaseRecord,
  scope: Scope,
  placeholders: ReadonlyMap<t.Node, string>,
): string[] {
  const lines: string[] = [];
  const ids = new Map<string, string>();
  const localId = (name: string): string => {
    let id = ids.get(name);
    if (id === undefined) {
      id = `<v${ids.size + 1}>`;
      ids.set(name, id);
    }
    return id;
  };
  const walk = (node: t.Node, at: string, inParams: boolean): void => {
    if (isTypeNode(node)) return;
    const placeholder = placeholders.get(node);
    if (placeholder !== undefined) {
      lines.push(`${at}\t${placeholder}`);
      if (t.isTemplateLiteral(node)) {
        node.expressions.forEach((expression, index) =>
          walk(expression, `${at}.expressions[${index}]`, inParams),
        );
      }
      return;
    }
    if (t.isIdentifier(node)) {
      const token = inParams
        ? '<param>'
        : scope.locals.has(node.name)
          ? localId(node.name)
          : `Identifier:${node.name}`;
      lines.push(`${at}\t${token}`);
      return;
    }
    lines.push(`${at}\t${node.type}${attributesOf(node)}`);
    const computed = (node as { computed?: unknown }).computed === true;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      if (TYPE_KEYS.has(key)) continue;
      const value: unknown = (node as unknown as Record<string, unknown>)[key];
      const nameSlot =
        key === 'label' ||
        (key === 'key' && !computed) ||
        (key === 'property' &&
          !computed &&
          (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)));
      if (nameSlot && isNode(value)) {
        const name = t.isIdentifier(value)
          ? value.name
          : t.isStringLiteral(value)
            ? value.value
            : gen(value);
        lines.push(`${at}.${key}\tName:${name}`);
        continue;
      }
      if (Array.isArray(value)) {
        value.forEach((item: unknown, index) => {
          if (isNode(item)) walk(item, `${at}.${key}[${index}]`, inParams);
          else lines.push(`${at}.${key}[${index}]\tnull`);
        });
      } else if (isNode(value)) walk(value, `${at}.${key}`, inParams);
    }
  };
  record.fn.params.forEach((param, index) => walk(param, `params[${index}]`, true));
  walk(record.fn.body, 'body', false);
  return lines;
}

/**
 * The nodes in which two facet-equal instances differ beyond their slots (KTD6): top-most
 * differing paths only. Empty when the facets differ (the guard applies to facet-equal pairs).
 */
export function residualDifference(a: InputFacet, b: InputFacet): ResidualDifference[] {
  if (a.fingerprint !== b.fingerprint) return [];
  const toMap = (lines: readonly string[]): Map<string, string> =>
    new Map(
      lines.map((line) => {
        const tab = line.indexOf('\t');
        return [line.slice(0, tab), line.slice(tab + 1)];
      }),
    );
  const left = toMap(a.skeleton);
  const right = toMap(b.skeleton);
  const paths = [...new Set([...left.keys(), ...right.keys()])];
  const differing = paths
    .map((at) => ({ path: at, a: left.get(at) ?? null, b: right.get(at) ?? null }))
    .filter((entry) => entry.a !== entry.b);
  const inside = (child: string, parent: string): boolean =>
    child.startsWith(`${parent}.`) || child.startsWith(`${parent}[`);
  return differing.filter(
    (entry) => !differing.some((other) => other !== entry && inside(entry.path, other.path)),
  );
}

/** {@link residualDifference}, and both facets marked unresolved when it is non-empty (D1). */
export function applyResidualGuard(
  a: InputFacet,
  b: InputFacet,
): { a: InputFacet; b: InputFacet; residual: ResidualDifference[] } {
  const residual = residualDifference(a, b);
  if (residual.length === 0) return { a, b, residual };
  const reason = `residual difference: ${residual.map((entry) => entry.path).join(', ')}`;
  const mark = (facet: InputFacet): InputFacet => ({
    ...facet,
    unresolved: [...new Set([...facet.unresolved, reason])].sort(),
  });
  return { a: mark(a), b: mark(b), residual };
}

/** True when two facets discarded the same values at the same positions. */
export function sameDiscardedValues(a: InputFacet, b: InputFacet): boolean {
  const key = (facet: InputFacet): string =>
    JSON.stringify(facet.discarded.map((entry) => [entry.position, entry.kind, entry.value]));
  return key(a) === key(b);
}

// ── Rules 7 / 8: fixtures ──────────────────────────────────────────────────

/** Fixture directories named by the `beforeAll` / `beforeEach` hooks around the test. */
function hookFixtureDirs(record: CaseRecord, index: FixtureIndex): string[] {
  const found = new Set<string>();
  for (const frame of record.chain) {
    for (const statement of frame.setup) {
      if (!t.isExpressionStatement(statement) || !t.isCallExpression(statement.expression))
        continue;
      const callee = statement.expression.callee;
      if (!t.isIdentifier(callee) || !/^before(All|Each)$/.test(callee.name)) continue;
      t.traverseFast(statement, (node) => {
        if (!t.isStringLiteral(node)) return;
        for (const dir of index.dirs.get(node.value) ?? []) found.add(dir);
      });
    }
  }
  return [...found];
}

interface FixtureParts {
  parts: string[];
  /** String values resolved against a fixture (they leave the data part). */
  resolved: Set<string>;
}

async function fixtureParts(
  record: CaseRecord,
  strings: readonly string[],
  ctx: FacetContext,
  unresolved: Set<string>,
): Promise<FixtureParts> {
  const parts: string[] = [];
  const resolved = new Set<string>();
  const index = ctx.fixtures();
  const presenceOnly = PRESENCE_QUERY.test(record.body) && !RELATION_QUERY.test(record.body);
  for (const dir of hookFixtureDirs(record, index)) {
    const defs = await ctx.shaper.fixtureDefs(dir);
    if (defs.files.size === 0) unresolved.add(`fixture dir ${dir}: no parseable source`);
    for (const literal of strings) {
      // The whole literal, or the word tokens of a composite one ('RunInterface → DoWork').
      for (const token of [literal, ...(literal.match(/[A-Za-z_$][\w$]*/g) ?? [])]) {
        for (const def of defs.names.get(token) ?? []) {
          resolved.add(literal);
          parts.push(`def:${presenceOnly ? def.kind : def.full}`);
          if (presenceOnly) continue;
          for (const ref of def.refs) {
            for (const field of defs.fields.get(ref) ?? []) parts.push(`field:${field}`);
            const type = defs.types.get(ref);
            if (type === undefined || ref === token) continue;
            parts.push(`type:${type.shape}`);
            for (const base of type.bases) {
              const baseType = defs.types.get(base);
              if (baseType !== undefined && base !== ref) parts.push(`type:${baseType.shape}`);
            }
          }
        }
      }
      if (literal === '') continue;
      for (const [relative, shape] of defs.files) {
        if (
          literal === relative ||
          literal.endsWith(`/${relative}`) ||
          relative.endsWith(literal)
        ) {
          parts.push(`file:${shape}`);
          resolved.add(literal);
        }
      }
    }
  }
  for (const literal of strings) {
    if (resolved.has(literal) || !PATHLIKE.test(literal)) continue;
    const hits = index.files.get(literal) ?? index.files.get(path.posix.basename(literal)) ?? [];
    if (hits.length !== 1) continue;
    const shape = await ctx.shaper.fixtureFileShape(hits[0]);
    if (shape === null) unresolved.add(`fixture file ${literal}: cannot be shaped`);
    else parts.push(`fixfile:${shape}`);
    resolved.add(literal);
  }
  return { parts, resolved };
}

// ── The facet ──────────────────────────────────────────────────────────────

interface SlotToken {
  /** Data token (rules 3, 4), or null for a source profile. */
  data: string | null;
  /** Source profile (rules 1, 2), or null. */
  source: string | null;
  order: string;
  exact: boolean;
}

const EXACT_STRING_SHAPES: ReadonlySet<string> = new Set(['EMPTY(0)', 'N0', 'N1', 'N-1']);
/** D2: `0`, `1`, `-1` and every negative stay exact. */
const boundaryNumber = (value: number): boolean => value === 0 || value === 1 || value < 0;

/** The input facet of one test instance. */
export async function computeFacet(subject: FacetSubject, ctx: FacetContext): Promise<InputFacet> {
  const { record } = subject;
  const scope = buildScope({ record, instance: subject.instance, fullName: null });
  const unresolved = new Set<string>();
  if (subject.instance === null && (record.each !== null || record.loop !== null)) {
    unresolved.add('instance not known');
  }
  for (const reason of subject.instance?.unresolved ?? []) unresolved.add(`instance: ${reason}`);
  // checks.ts flags free names an untracked outer row may bind, and unknown selector values.
  abstractNode(record.fn.body, scope, false, false);
  const selectors = selectorNodes(record.fn.body, scope);
  const { slots, keys, placeholders } = collectSlots(record, scope, selectors, unresolved);

  const executed = (subject.executedFiles ?? []).filter((file) => ctx.isProduction(file)).sort();
  if (subject.executedFiles === null) unresolved.add('executed files not known');
  const closure = ctx.closureOf(subject);
  if (closure === null) unresolved.add('import closure not known');
  const search = { executed, closure: closure?.near ?? [] };
  const constants = ctx.tables.constantsOf([...new Set([...executed, ...(closure?.all ?? [])])]);

  const strings = slots.filter((slot) => slot.kind === 'string').map((slot) => slot.value);
  const literals: LiteralKey[] = slots.map((slot) =>
    slot.number !== null ? numberKey(slot.number) : stringKey(slot.value.trim()),
  );
  const rowText = (subject.instance?.dimensions ?? [])
    .map((dimension) => (dimension.node === null ? '' : gen(dimension.node)))
    .join('\n');
  const lang = languageOf(`${record.body}\n${rowText}`, record.file, strings);
  const fixtures = ctx.fixtures();
  const tableOf = (value: LiteralKey): string | null => ctx.tables.tableOf(search, value, literals);

  const tokenOf = async (slot: Slot): Promise<SlotToken> => {
    if (slot.kind === 'string') {
      const text = slot.value;
      if (lang === SupportedLanguages.Cobol) {
        const words = cobolWords(text);
        if (words.length > 0) {
          const profile = `cobol:${words
            .map((word) => {
              const table = tableOf(stringKey(word));
              return table === null ? word : `T:${table}`;
            })
            .sort()
            .join(',')}`;
          return { data: null, source: profile, order: profile, exact: false };
        }
      }
      const profile =
        lang !== null && looksLikeSource(text) ? await ctx.shaper.syntaxProfile(lang, text) : null;
      if (profile !== null) return { data: null, source: profile, order: profile, exact: false };
      if (slot.selector)
        return { data: `SEL:${text}`, source: null, order: `SEL:${text}`, exact: true };
      const table = tableOf(stringKey(text.trim()));
      const synthetic =
        PATHLIKE.test(text) &&
        !fixtures.files.has(text) &&
        !fixtures.files.has(path.posix.basename(text));
      const extension = table === null && synthetic ? /(\.\w{1,6})$/.exec(text)?.[1] : undefined;
      const extensionTable =
        extension === undefined
          ? null
          : (tableOf(stringKey(extension)) ?? tableOf(stringKey(extension.slice(1))));
      const shape = shapeText(text);
      const data =
        table !== null ? `T:${table}` : extensionTable !== null ? `T:${extensionTable}` : shape;
      const exact = data === shape && EXACT_STRING_SHAPES.has(shape);
      return { data, source: null, order: shape, exact };
    }
    if (slot.kind === 'bigint') {
      const exact = slot.selector || /^-|^[01]$/.test(slot.value);
      const token = exact ? `#=${slot.value}n` : `#${shapeText(slot.value)}n`;
      return { data: token, source: null, order: token, exact };
    }
    const value = slot.number ?? Number.NaN;
    if (slot.selector) {
      return { data: `SEL#${slot.value}`, source: null, order: `SEL#${slot.value}`, exact: true };
    }
    if (boundaryNumber(value) || nearConstant(constants, value)) {
      return { data: `#=${slot.value}`, source: null, order: `#=${slot.value}`, exact: true };
    }
    const shape = `#${shapeText(slot.value)}`;
    const table = tableOf(numberKey(value));
    return {
      data: table === null ? shape : `T:${table}`,
      source: null,
      order: shape,
      exact: false,
    };
  };

  const tokens: SlotToken[] = [];
  for (const slot of slots) tokens.push(await tokenOf(slot));
  const { parts: fixtureTokens, resolved } = await fixtureParts(record, strings, ctx, unresolved);

  const source = [
    ...new Set(tokens.flatMap((token) => (token.source === null ? [] : [token.source]))),
  ].sort();
  const fixtureSet = [...new Set(fixtureTokens)].sort();
  const data = [
    ...tokens.flatMap((token, index) => {
      const slot = slots[index];
      const isResolved = slot.kind === 'string' && resolved.has(slot.value);
      return token.data === null || isResolved ? [] : [token.data];
    }),
    ...keys,
  ].sort();
  const parts: FacetParts = {
    language: source.length > 0 || fixtureSet.length > 0 ? (lang ?? '-') : '-',
    source,
    fixtures: fixtureSet,
    data,
    calls: calledNames(record.fn.body, scope),
    order: tokens.map((token) => token.order),
  };
  const discarded: DiscardedValue[] = [];
  slots.forEach((slot, index) => {
    const isResolved = slot.kind === 'string' && resolved.has(slot.value);
    if (tokens[index].exact && !isResolved) return;
    const start = slot.node.loc?.start;
    discarded.push({
      position: index,
      kind: slot.kind,
      value: slot.value,
      location: { file: record.file, line: start?.line ?? 0, column: start?.column ?? 0 },
      origin: slot.origin,
    });
  });
  for (const reason of scope.unresolved) unresolved.add(reason);
  return {
    fingerprint: sha1(
      [
        parts.language,
        `S:${parts.source.join(' / ')}`,
        `F:${parts.fixtures.join(' / ')}`,
        `D:${parts.data.join(' / ')}`,
        `calls:${parts.calls.join(',')}`,
        `order:${parts.order.join('\u0001')}`,
      ].join('|'),
    ),
    parts,
    discarded,
    unresolved: [...unresolved].sort(),
    skeleton: skeletonOf(record, scope, placeholders),
  };
}
