/**
 * Report identities of the scenario map (U13, KTD13, design §5.5): the continuity side of the two
 * identities. Execution identities (Phase 0 test ids, global mutant ids) are revision-pinned and
 * stay in the report as provenance; week-over-week continuity uses the fingerprints here, so an
 * unrelated edit (a line inserted above, a commit that changes another file) does not resurface a
 * finding.
 *
 * Mutant fingerprint ({@link fingerprintMutants}): the file, the operator (Stryker mutator name),
 * the replacement (the 16-digit sha256 prefix the global id carries) and the normalised enclosing
 * statement, without revision or span. The enclosing statement is the smallest Babel statement of
 * the ORIGINAL source (not the prepared copy) that contains the mutant's span; class members count
 * as statements, so a mutant in a class property does not take the whole class. It is normalised
 * by regenerating it compact and without comments. Two mutants with the same operator and
 * replacement in one statement are told apart by the occurrence: how often the mutated text
 * appears in the statement before the span. Consequence: any edit inside a statement (a table
 * row added to a `const` table, say) renews the fingerprints of every mutant in it. A mutant whose
 * source cannot be read, no longer has the content hash of its global id, does not parse or lies
 * outside every statement falls back to a fingerprint of its global id, with the reason recorded.
 *
 * Universe identifier ({@link universeIdOf}, KTD13): a hash of the sorted mutant fingerprints of a
 * pair's common universe, so regrouping alone (another group id, another run) keeps it.
 *
 * Evidence hash ({@link evidenceHash}, design §5.5): a hash of a canonical JSON record. The record
 * itself is assembled by report.ts from fingerprints only, never revisions or line positions.
 *
 * Test anchors come from U3 (inventory/identity.ts); {@link fallbackAnchor} gives a test without a
 * one-to-one static join an anchor keyed by its execution identity, which never moves.
 *
 * Library only; pure except for the injected source reader.
 */
import { generate } from '@babel/generator';
import { parse, type ParserPlugin } from '@babel/parser';
import * as t from '@babel/types';
import { contentHash, type ReportLocation } from '../../mutation/prepare/mutant-identity.js';
import { indexSource, locationToOffsets } from '../../mutation/prepare/span-map-check.js';
import type { TestAnchor } from '../types.js';
import { byText, sha1, sha256 } from '../util.js';

/** JSON data, the only input of {@link evidenceHash}. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const SHORT = 16;

// ── Global mutant ids ──────────────────────────────────────────────────────

/** The fields of a global mutant id (tools/mutation/prepare/mutant-identity.ts). */
export interface ParsedMutantId {
  /** Repo path of the original file. */
  file: string;
  /** First 16 hex digits of the original file's sha256. */
  fileHash: string;
  location: ReportLocation;
  mutator: string;
  /** First 16 hex digits of the replacement's sha256. */
  replacement: string;
}

const GLOBAL_ID =
  /^(.+)@([0-9a-f]{16}):(\d+):(\d+)-(\d+):(\d+):([A-Za-z][A-Za-z0-9]*):([0-9a-f]{16})$/;

/** Parses `<file>@<hash>:<l>:<c>-<l>:<c>:<mutator>:<replacement hash>`; null when malformed. */
export function parseGlobalMutantId(id: string): ParsedMutantId | null {
  const match = GLOBAL_ID.exec(id);
  if (match === null) return null;
  const [, file, fileHash, sl, sc, el, ec, mutator, replacement] = match;
  return {
    file,
    fileHash,
    location: {
      start: { line: Number(sl), column: Number(sc) },
      end: { line: Number(el), column: Number(ec) },
    },
    mutator,
    replacement,
  };
}

// ── Mutant fingerprints ────────────────────────────────────────────────────

/** Why a fingerprint fell back to the revision-pinned global id. */
export type FingerprintFallback =
  | 'malformed-id'
  | 'unreadable'
  | 'content-changed'
  | 'unparsable'
  | 'span-outside'
  | 'no-statement'
  | 'not-fingerprinted';

export const FINGERPRINT_FALLBACKS: readonly FingerprintFallback[] = [
  'malformed-id',
  'unreadable',
  'content-changed',
  'unparsable',
  'span-outside',
  'no-statement',
  'not-fingerprinted',
];

export interface MutantFingerprint {
  /** `m` + 16 hex digits. */
  fingerprint: string;
  /** Null for a continuity fingerprint; else why it names the global id instead. */
  fallback: FingerprintFallback | null;
}

/** Global mutant id → fingerprint. */
export type MutantFingerprints = ReadonlyMap<string, MutantFingerprint>;

/** The fingerprint of a mutant that has no continuity fingerprint: its global id. */
export const fallbackFingerprint = (
  globalId: string,
  fallback: FingerprintFallback,
): MutantFingerprint => ({
  fingerprint: `m${sha256(JSON.stringify(['global-id', globalId])).slice(0, SHORT)}`,
  fallback,
});

/** Statements, plus the class members that play their part inside a class body. */
const isStatementLike = (node: t.Node): boolean =>
  t.isStatement(node) ||
  t.isClassProperty(node) ||
  t.isClassPrivateProperty(node) ||
  t.isClassAccessorProperty(node) ||
  t.isClassMethod(node) ||
  t.isClassPrivateMethod(node);

const pluginsOf = (file: string): ParserPlugin[] =>
  /\.[mc]?[jt]sx$/.test(file)
    ? ['typescript', 'jsx', 'decorators-legacy']
    : ['typescript', 'decorators-legacy'];

/** A statement-like node with its offsets and its position in traversal order. */
interface Statement {
  node: t.Node;
  start: number;
  end: number;
  /** Index in traversal order (parents before children). */
  order: number;
}

/** A parsed original source, shared by the mutants of one file. */
interface ParsedSource {
  text: string;
  index: ReturnType<typeof indexSource>;
  /** Statement-like nodes with offsets, sorted by start (traversal order among equal starts). */
  statements: Statement[];
  /** Normalised code of each statement already generated. */
  code: Map<t.Node, string>;
}

function parseSource(file: string, text: string): ParsedSource | null {
  let program: t.File;
  try {
    program = parse(text, { sourceType: 'module', plugins: pluginsOf(file) });
  } catch {
    return null;
  }
  const statements: Statement[] = [];
  let order = 0;
  t.traverseFast(program, (node) => {
    if (!isStatementLike(node)) return;
    if (node.start != null && node.end != null) {
      statements.push({ node, start: node.start, end: node.end, order });
    }
    order += 1;
  });
  statements.sort((x, y) => x.start - y.start);
  return { text, index: indexSource(text, file), statements, code: new Map() };
}

/**
 * The deepest statement holding `[start, end)`: the smallest span, the later in traversal order
 * (the deeper) among equal spans; null when none does. A statement holding the span starts at or
 * before `start`, so only that prefix of the start-sorted list is read, backwards, and the walk
 * stops once a statement starts too early to be as small as the best found
 * (`end - its start > best size`).
 */
function deepestStatement(
  statements: readonly Statement[],
  start: number,
  end: number,
): Statement | null {
  let low = 0;
  let high = statements.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (statements[middle].start <= start) low = middle + 1;
    else high = middle;
  }
  let best: Statement | null = null;
  for (let i = low - 1; i >= 0; i--) {
    const statement = statements[i];
    if (best !== null && statement.start < end - (best.end - best.start)) break;
    if (statement.end < end) continue;
    const size = statement.end - statement.start;
    const bestSize = best === null ? Infinity : best.end - best.start;
    if (size < bestSize || (size === bestSize && best !== null && statement.order > best.order)) {
      best = statement;
    }
  }
  return best;
}

/** The normalised enclosing statement and occurrence of a span; a fallback reason otherwise. */
function enclosingCode(
  parsed: ParsedSource,
  location: ReportLocation,
): { code: string; occurrence: number } | FingerprintFallback {
  let start: number;
  let end: number;
  try {
    ({ start, end } = locationToOffsets(parsed.index, location));
  } catch {
    return 'span-outside';
  }
  const best = deepestStatement(parsed.statements, start, end);
  if (best === null) return 'no-statement';
  const mutated = parsed.text.slice(start, end);
  let occurrence = 0;
  if (mutated.length > 0) {
    for (let at = parsed.text.indexOf(mutated, best.start); at !== -1 && at < start; ) {
      occurrence += 1;
      at = parsed.text.indexOf(mutated, at + 1);
    }
  }
  let code = parsed.code.get(best.node);
  if (code === undefined) {
    code = generate(best.node, { comments: false, compact: true }).code;
    parsed.code.set(best.node, code);
  }
  return { code, occurrence };
}

/**
 * Fingerprints every global mutant id; see the module comment. `read` returns the original text
 * of a repo path, or null when it cannot. Each file is read and parsed once.
 */
export function fingerprintMutants(
  ids: Iterable<string>,
  read: (repoPath: string) => string | null,
): Map<string, MutantFingerprint> {
  const parsedByFile = new Map<string, ParsedSource | FingerprintFallback>();
  const sourceOf = (id: ParsedMutantId): ParsedSource | FingerprintFallback => {
    const key = `${id.file}@${id.fileHash}`;
    const known = parsedByFile.get(key);
    if (known !== undefined) return known;
    const text = read(id.file);
    const parsed =
      text === null
        ? 'unreadable'
        : contentHash(text).slice(0, SHORT) !== id.fileHash
          ? 'content-changed'
          : (parseSource(id.file, text) ?? 'unparsable');
    parsedByFile.set(key, parsed);
    return parsed;
  };
  const result = new Map<string, MutantFingerprint>();
  for (const globalId of [...new Set(ids)].sort(byText)) {
    const id = parseGlobalMutantId(globalId);
    if (id === null) {
      result.set(globalId, fallbackFingerprint(globalId, 'malformed-id'));
      continue;
    }
    const parsed = sourceOf(id);
    const code = typeof parsed === 'string' ? parsed : enclosingCode(parsed, id.location);
    result.set(
      globalId,
      typeof code === 'string'
        ? fallbackFingerprint(globalId, code)
        : {
            fingerprint: `m${sha256(
              JSON.stringify([id.file, id.mutator, id.replacement, code.code, code.occurrence]),
            ).slice(0, SHORT)}`,
            fallback: null,
          },
    );
  }
  return result;
}

/** The fingerprint of one id, or its global-id fallback when `fingerprints` lacks it. */
export const fingerprintOf = (fingerprints: MutantFingerprints, globalId: string): string =>
  (fingerprints.get(globalId) ?? fallbackFingerprint(globalId, 'not-fingerprinted')).fingerprint;

/**
 * KTD13 universe identifier: `u` + 16 hex digits of sha256 over the sorted fingerprints (repeats
 * kept); null for an empty universe.
 */
export function universeIdOf(fingerprints: readonly string[]): string | null {
  if (fingerprints.length === 0) return null;
  const sorted = [...fingerprints].sort(byText);
  return `u${sha256(JSON.stringify(sorted)).slice(0, SHORT)}`;
}

/** Design §5.5 evidence hash: `e` + 16 hex digits of sha256 over the record's JSON. */
export const evidenceHash = (record: JsonValue): string =>
  `e${sha256(JSON.stringify(record)).slice(0, SHORT)}`;

// ── Test anchors ───────────────────────────────────────────────────────────

/**
 * The anchor of a test without a one-to-one static join: keyed by its execution identity, with no
 * row fingerprint, so it never moves (identity.ts `matchAnchors`).
 */
export function fallbackAnchor(testId: string): TestAnchor {
  const hash = testId.indexOf('#');
  return {
    key: `exec:${sha1(testId)}`,
    file: hash === -1 ? testId : testId.slice(0, hash),
    describePath: [],
    title: hash === -1 ? testId : testId.slice(hash + 1),
    rowFingerprint: null,
    bodyFingerprint: '',
  };
}
