/**
 * Global mutant identity (origin §2, KTD12).
 *
 * Stryker numbers mutants per run, so a local id means nothing across runs (the runner's run
 * and the oracle's run, KTD18) or across freezes. The global identity names a mutant by its
 * original source instead: the repo path of the original file (prepared paths translate through
 * the path map), the sha256 content hash of the original file, the span, the mutator name and
 * the replacement. Content hashes survive squash-merges and shallow checkouts, which git SHAs
 * do not.
 *
 * The span is the report's location as-is: 1-based lines and columns, end exclusive. The
 * prepared copy differs from the original only by `as` assertions blanked to spaces of the same
 * length (KTD7), so the map is an identity on lines and columns; span-map-check.ts proves that
 * for every mutant.
 *
 * Global id format, one line, fields in this order:
 *   <repo path>@<file hash 16>:<start line>:<start column>-<end line>:<end column>:<mutator>:<replacement hash 16>
 * where each hash is the first 16 hex digits of a sha256 digest (the replacement's over its
 * UTF-8 text). The full file hash stays in {@link MutantIdentity.fileHash}.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { toRepoPathFromPackageDir } from './path-map.js';

/** A 1-based line and column, as in Stryker's mutation-testing report. */
export interface ReportPosition {
  line: number;
  column: number;
}

/** A report span: 1-based positions, `end` exclusive. */
export interface ReportLocation {
  start: ReportPosition;
  end: ReportPosition;
}

export const MUTANT_STATUSES = [
  'Killed',
  'Survived',
  'NoCoverage',
  'CompileError',
  'RuntimeError',
  'Timeout',
  'Ignored',
  'Pending',
] as const;

export type MutantStatus = (typeof MUTANT_STATUSES)[number];

/** The mutant fields this tooling consumes from `files[path].mutants[]`. */
export interface ReportMutant {
  /** Stryker's local id, unique within one run. */
  id: string;
  mutatorName: string;
  replacement: string;
  location: ReportLocation;
  status: MutantStatus;
  statusReason?: string;
  static?: boolean;
  testsCompleted?: number;
  coveredBy?: string[];
  killedBy?: string[];
}

export interface ReportFile {
  language: string;
  /** The file text Stryker mutated (the prepared copy's text). */
  source: string;
  mutants: ReportMutant[];
}

/** The parts of Stryker's `mutation.json` (mutation-testing-report-schema 1.x) used here. */
export interface MutationReport {
  schemaVersion: string;
  /** The directory Stryker ran in; report file keys are relative to it. */
  projectRoot?: string;
  files: Record<string, ReportFile>;
}

export interface MutantIdentity {
  /** Repo-relative POSIX path of the original source file. */
  file: string;
  /** sha256 hex digest of the original file's UTF-8 text. */
  fileHash: string;
  location: ReportLocation;
  mutatorName: string;
  replacement: string;
}

export interface IdentifiedMutant {
  localId: string;
  globalId: string;
  identity: MutantIdentity;
  /** The report's file key, relative to the directory Stryker ran in. */
  reportFile: string;
  mutant: ReportMutant;
}

export interface RunIdentities {
  /** Every mutant of the run, in report order. */
  mutants: IdentifiedMutant[];
  localToGlobal: ReadonlyMap<string, string>;
  /** Original file text by repo path, as read for the content hashes. */
  originals: ReadonlyMap<string, string>;
}

export interface IdentifyOptions {
  /** Absolute directory that ran Stryker: the prepared `gitnexus/` copy or its sandbox. */
  packageDir: string;
  /** Reads an original source file by repo-relative path. */
  readOriginal: (repoPath: string) => string;
}

const SCHEMA_VERSION = /^1(\.\d+)*$/;
/** Mutator names are identifiers, so the global id stays parseable from the right. */
const MUTATOR_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const STATUSES: ReadonlySet<string> = new Set(MUTANT_STATUSES);
const SHORT_HASH = 16;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

const isStatus = (value: string): value is MutantStatus => STATUSES.has(value);

// A function declaration, so a call in statement position narrows like a `throw`.
function fail(at: string, detail: string): never {
  throw new Error(`mutation report: ${at} ${detail}`);
}

function requireString(value: unknown, at: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || (pattern !== undefined && !pattern.test(value))) {
    return fail(at, `must be a string${pattern === undefined ? '' : ` matching ${pattern}`}`);
  }
  return value;
}

function optionalStrings(value: unknown, at: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return fail(at, 'must be an array of strings');
  }
  return [...value];
}

function parsePosition(value: unknown, at: string): ReportPosition {
  if (!isRecord(value) || !isPositiveInteger(value.line) || !isPositiveInteger(value.column)) {
    return fail(at, 'must have a positive integer line and column');
  }
  return { line: value.line, column: value.column };
}

function parseLocation(value: unknown, at: string): ReportLocation {
  if (!isRecord(value)) return fail(at, 'must be an object');
  const start = parsePosition(value.start, `${at}.start`);
  const end = parsePosition(value.end, `${at}.end`);
  if (end.line < start.line || (end.line === start.line && end.column < start.column)) {
    fail(at, 'ends before it starts');
  }
  return { start, end };
}

function parseMutant(value: unknown, at: string): ReportMutant {
  if (!isRecord(value)) return fail(at, 'must be an object');
  const status = requireString(value.status, `${at}.status`);
  if (!isStatus(status)) fail(`${at}.status`, `is not a known status: ${status}`);
  const mutant: ReportMutant = {
    id: requireString(value.id, `${at}.id`),
    mutatorName: requireString(value.mutatorName, `${at}.mutatorName`, MUTATOR_NAME),
    replacement: requireString(value.replacement, `${at}.replacement`),
    location: parseLocation(value.location, `${at}.location`),
    status,
  };
  if (value.statusReason !== undefined) {
    mutant.statusReason = requireString(value.statusReason, `${at}.statusReason`);
  }
  const { static: isStatic, testsCompleted } = value;
  if (isStatic !== undefined) {
    if (typeof isStatic !== 'boolean') fail(`${at}.static`, 'must be a boolean');
    mutant.static = isStatic;
  }
  if (testsCompleted !== undefined) {
    if (typeof testsCompleted !== 'number') fail(`${at}.testsCompleted`, 'must be a number');
    mutant.testsCompleted = testsCompleted;
  }
  const coveredBy = optionalStrings(value.coveredBy, `${at}.coveredBy`);
  if (coveredBy !== undefined) mutant.coveredBy = coveredBy;
  const killedBy = optionalStrings(value.killedBy, `${at}.killedBy`);
  if (killedBy !== undefined) mutant.killedBy = killedBy;
  return mutant;
}

function parseFile(value: unknown, at: string): ReportFile {
  if (!isRecord(value)) return fail(at, 'must be an object');
  const list = value.mutants;
  if (!Array.isArray(list)) fail(`${at}.mutants`, 'must be an array');
  const mutants: readonly unknown[] = list;
  return {
    language: requireString(value.language, `${at}.language`),
    source: requireString(value.source, `${at}.source`),
    mutants: mutants.map((mutant, i) => parseMutant(mutant, `${at}.mutants[${i}]`)),
  };
}

/** Parses and validates Stryker's `mutation.json` text. */
export function parseMutationReport(text: string): MutationReport {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) return fail('root', 'must be an object');
  const schemaVersion = requireString(data.schemaVersion, 'schemaVersion', SCHEMA_VERSION);
  if (!isRecord(data.files)) return fail('files', 'must be an object keyed by file path');
  // fromEntries defines own properties, so no file key can reach the prototype.
  const files = Object.fromEntries(
    Object.entries(data.files).map(([file, value]) => [
      file,
      parseFile(value, `files[${JSON.stringify(file)}]`),
    ]),
  );
  const report: MutationReport = { schemaVersion, files };
  if (data.projectRoot !== undefined) {
    report.projectRoot = requireString(data.projectRoot, 'projectRoot');
  }
  return report;
}

export function readMutationReport(file: string): MutationReport {
  return parseMutationReport(readFileSync(file, 'utf8'));
}

/** Reads original sources from a repo checkout. */
export function readRepoFile(repoRoot: string): (repoPath: string) => string {
  return (repoPath) => readFileSync(path.join(repoRoot, repoPath), 'utf8');
}

/** sha256 hex digest of a text's UTF-8 encoding. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The global id of an identity; see the module comment for the format. */
export function formatGlobalId(identity: MutantIdentity): string {
  const { start, end } = identity.location;
  return (
    `${identity.file}@${identity.fileHash.slice(0, SHORT_HASH)}` +
    `:${start.line}:${start.column}-${end.line}:${end.column}` +
    `:${identity.mutatorName}:${contentHash(identity.replacement).slice(0, SHORT_HASH)}`
  );
}

/**
 * Gives every mutant of one run its global identity and returns the local-id map. Throws for a
 * file outside the mapped roots, a repeated local id, or two local mutants with the same global
 * identity (the map would not be one-to-one, so cross-run comparisons could not use it).
 */
export function identifyMutants(report: MutationReport, options: IdentifyOptions): RunIdentities {
  const originals = new Map<string, string>();
  const hashes = new Map<string, string>();
  const localToGlobal = new Map<string, string>();
  const globalToLocal = new Map<string, string>();
  const mutants: IdentifiedMutant[] = [];
  for (const [reportFile, fileResult] of Object.entries(report.files)) {
    const file = toRepoPathFromPackageDir(
      options.packageDir,
      path.resolve(options.packageDir, reportFile),
    );
    let fileHash = hashes.get(file);
    if (fileHash === undefined) {
      const original = options.readOriginal(file);
      fileHash = contentHash(original);
      originals.set(file, original);
      hashes.set(file, fileHash);
    }
    for (const mutant of fileResult.mutants) {
      const identity: MutantIdentity = {
        file,
        fileHash,
        location: {
          start: { ...mutant.location.start },
          end: { ...mutant.location.end },
        },
        mutatorName: mutant.mutatorName,
        replacement: mutant.replacement,
      };
      const globalId = formatGlobalId(identity);
      if (localToGlobal.has(mutant.id)) {
        throw new Error(`mutant identity: local id ${mutant.id} appears twice in the report`);
      }
      const twin = globalToLocal.get(globalId);
      if (twin !== undefined) {
        throw new Error(
          `mutant identity: local ids ${twin} and ${mutant.id} have the same global identity ${globalId}`,
        );
      }
      localToGlobal.set(mutant.id, globalId);
      globalToLocal.set(globalId, mutant.id);
      mutants.push({ localId: mutant.id, globalId, identity, reportFile, mutant });
    }
  }
  return { mutants, localToGlobal, originals };
}
