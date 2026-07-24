import { createFTSIndex, dropFTSIndex, DEFAULT_FTS_STEMMER } from '../lbug/lbug-adapter.js';
import { getExtensionCapabilities } from '../lbug/extension-loader.js';
import { classifyExtensionLoadError } from '../lbug/extension-load-error.js';
import { FTS_INDEXES } from './fts-schema.js';

/**
 * Strip filesystem paths from a LadybugDB error before it reaches the HTTP
 * `/api/search` and MCP query surfaces (#2374, PR #2375): the raw LOAD error
 * embeds the absolute extension path (username, home dir) which must not leak to
 * a network client. The error class words ("Failed to load library", "invalid
 * ELF header", "has not been installed") have no leading path separator and
 * survive. CLI/doctor/log surfaces keep the full path (they read the reason
 * directly, not through this function).
 */
const redactPaths = (reason: string): string =>
  reason.replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, '<path>');

/**
 * Warning attached to search responses when BM25/FTS is degraded. Prefers the
 * live extension-load failure (with LadybugDB's real reason, #2374) over the
 * generic indexes-missing message, so "indexes exist but the extension broke"
 * is not misreported as missing indexes.
 */
export const ftsDegradedWarning = (): string => {
  const fts = getExtensionCapabilities().find((c) => c.name === 'fts');
  if (fts && !fts.loaded) {
    const reason = fts.reason ? redactPaths(fts.reason).replace(/\.$/, '') : undefined;
    // A missing *runtime dependency* (Windows error 126, etc.) is not healed by
    // reinstalling (#2374) — surface the classified remedy instead of the generic
    // reinstall tail. Read the diagnosis cached at mark-unavailable time so this
    // per-request path (HTTP /api/search + MCP query) does NO file I/O (#2383 F3);
    // fall back to the pure, no-I/O string classifier if it is somehow absent.
    const { kind, remedy } = fts.diagnosis ?? classifyExtensionLoadError(fts.reason);
    const tail =
      kind === 'missing_dependency'
        ? ` ${remedy}`
        : '. Run `gitnexus doctor` for details, then `gitnexus analyze --repair-fts` with network access to reinstall.';
    return (
      'FTS extension failed to load — keyword search degraded' +
      (reason ? ` (${reason})` : '') +
      tail
    );
  }
  return 'FTS indexes missing — keyword search degraded. Run: gitnexus analyze --repair-fts (or gitnexus analyze --force) to rebuild indexes.';
};

// Stemmers shipped by the LadybugDB FTS extension. Mirrors the lowercase token
// set in the extension bundled with @ladybugdb/core 0.18.x (see package.json).
// Keep in sync on a LadybugDB minor bump — a value here that the installed
// extension rejects would pass validation but fail at CREATE_FTS_INDEX.
// Exported so the re-validation sweep in fts-stemmer-sweep.test.ts iterates the
// canonical list rather than a copy that could silently drift from it.
export const SUPPORTED_FTS_STEMMERS: ReadonlySet<string> = new Set<string>([
  'arabic',
  'basque',
  'catalan',
  'danish',
  'dutch',
  'english',
  'finnish',
  'french',
  'german',
  'greek',
  'hindi',
  'hungarian',
  'indonesian',
  'irish',
  'italian',
  'lithuanian',
  'nepali',
  'norwegian',
  'none',
  'porter',
  'portuguese',
  'romanian',
  'russian',
  'serbian',
  'spanish',
  'swedish',
  'tamil',
  'turkish',
]);

export interface CreateSearchFTSIndexesOptions {
  onIndexStart?: (table: string, indexName: string) => void;
  onIndexReady?: (table: string, indexName: string) => void;
}

let resolvedStemmer: string | undefined;

/** Read + validate `GITNEXUS_FTS_STEMMER`. Throws on an unsupported value. */
function resolveFTSStemmer(): string {
  const raw = process.env.GITNEXUS_FTS_STEMMER?.trim().toLowerCase();
  if (!raw) return DEFAULT_FTS_STEMMER;
  if (SUPPORTED_FTS_STEMMERS.has(raw)) return raw;

  throw new Error(
    `Invalid GITNEXUS_FTS_STEMMER "${process.env.GITNEXUS_FTS_STEMMER}". ` +
      `Expected one of: ${[...SUPPORTED_FTS_STEMMERS].sort().join(', ')}.`,
  );
}

/**
 * Resolve + validate `GITNEXUS_FTS_STEMMER` once, up front at analyze startup,
 * and cache it. An invalid value throws here — in milliseconds — instead of
 * ~85% into a run (after the expensive parse/scope-resolution work). The cached
 * value is what {@link getSearchFTSStemmer} returns for the rest of the run, so
 * config is read and validated in exactly one place.
 */
export function initialiseSearchFTSStemmer(): string {
  resolvedStemmer = resolveFTSStemmer();
  return resolvedStemmer;
}

/**
 * Return the stemmer resolved by {@link initialiseSearchFTSStemmer}. Falls back
 * to resolving on demand when init was never called (read-only hosts, unit
 * tests) so validation always applies.
 */
export function getSearchFTSStemmer(): string {
  return resolvedStemmer ?? resolveFTSStemmer();
}

/**
 * Drop every configured FTS index (no-op per index when absent or unloadable
 * — `dropFTSIndex` tolerates both). Callable ahead of any DML that mutates an
 * FTS-indexed table's rows: LadybugDB's FTS extension is not proven to
 * survive a DETACH DELETE against a table that still carries a live index
 * from a prior run (#2589) — dropping first removes that hazard entirely,
 * regardless of whether it also fixed a specific native inconsistency.
 */
export async function dropSearchFTSIndexes(): Promise<void> {
  for (const { table, indexName } of FTS_INDEXES) {
    await dropFTSIndex(table, indexName);
  }
}

export async function createSearchFTSIndexes(
  options?: CreateSearchFTSIndexesOptions,
): Promise<void> {
  const stemmer = getSearchFTSStemmer();
  for (const { table, indexName, properties } of FTS_INDEXES) {
    options?.onIndexStart?.(table, indexName);
    // Drop first so the live `properties` always win. `createFTSIndex` is
    // idempotent-by-name (skips when the index already exists), so without the
    // drop a schema change — e.g. adding `description` (#2299) — would never
    // reach an existing `.lbug` DB on an incremental re-analyze or `--repair-fts`;
    // the old name+content index would silently persist. `dropFTSIndex` no-ops
    // when the index is absent (first-ever analyze) and clears the per-connection
    // memo so the create below actually runs.
    // ponytail: this rebuilds every FTS index on every analyze instead of
    // skipping when present; FTS build is proportional to symbol-table size and
    // runs inside the existing FTS phase. Gate on a stored schema fingerprint if
    // this rebuild cost ever shows up in analyze profiles.
    await dropFTSIndex(table, indexName);
    await createFTSIndex(table, indexName, [...properties], stemmer);
    options?.onIndexReady?.(table, indexName);
  }
}

export async function verifySearchFTSIndexes(
  executeQuery: (cypher: string) => Promise<unknown[]>,
): Promise<string[]> {
  // Read the catalog once and check each configured index both EXISTS and
  // covers its expected columns. A queryability-only probe (CALL QUERY_FTS_INDEX
  // ... catch) is not enough: a stale `name+content`-only index left on a
  // pre-#2299 DB stays queryable yet silently misses `description`, so the probe
  // would pass while doc-comment search is still broken (#2299). SHOW_INDEXES
  // exposes `property_names` (STRING[]) per index, so we assert coverage directly.
  const rows = await executeQuery('CALL SHOW_INDEXES() RETURN *');

  const propsByIndex = new Map<string, readonly string[]>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const indexName = record.index_name;
    const propertyNames = record.property_names;
    if (typeof indexName !== 'string' || !Array.isArray(propertyNames)) continue;
    propsByIndex.set(
      indexName,
      propertyNames.filter((p): p is string => typeof p === 'string'),
    );
  }

  const missing: string[] = [];
  for (const { table, indexName, properties } of FTS_INDEXES) {
    const actual = propsByIndex.get(indexName);
    // Absent from the catalog, or present but not covering every expected column.
    if (!actual || !properties.every((p) => actual.includes(p))) {
      missing.push(`${table}.${indexName}`);
    }
  }
  return missing;
}

/**
 * Why an FTS build failed, so the caller can react correctly (#2658):
 *
 *  - `capability`: the environment can't support FTS this run, or a single
 *    pre-existing row can't be tokenized (#2544/#2546 "Invalid UTF-8"). The
 *    graph/embeddings work is sound — degrade keyword search and keep exit 0.
 *  - `integrity`: an IO / rename / checkpoint / corruption failure while
 *    writing the index. With the single-writer lock (#2658) this is no longer
 *    "some other analyze racing us" — it's a genuinely broken build on this
 *    disk, so the run must fail loudly rather than publish a clean-looking
 *    index whose search silently never worked.
 */
export type FtsBuildFailureClass = 'capability' | 'integrity';

// Checked before integrity signatures: a row-level tokenizer error that happens
// to mention an integrity word still degrades (it isn't a broken build).
const FTS_CAPABILITY_SIGNATURES = ['invalid utf-8', 'failed calling lower', 'tokeniz'] as const;
// IO / durability / corruption signatures that mean the build itself broke.
const FTS_INTEGRITY_SIGNATURES = [
  'io exception',
  'i/o error',
  'io error',
  'error renaming',
  'checkpoint',
  'no such file or directory',
  'corrupt',
  'no space',
  'enospc',
  'bad file descriptor',
  'ebadf',
  'double free',
  'segmentation',
] as const;

/**
 * Classify an FTS build failure message. Defaults to `capability` (degrade) —
 * only clearly-integrity failures escalate, so the long-standing resilience to
 * row-level tokenizer errors is preserved and we never newly fail a run on an
 * unrecognised message.
 */
export const classifyFtsBuildError = (message: string): FtsBuildFailureClass => {
  const m = message.toLowerCase();
  if (FTS_CAPABILITY_SIGNATURES.some((s) => m.includes(s))) return 'capability';
  if (FTS_INTEGRITY_SIGNATURES.some((s) => m.includes(s))) return 'integrity';
  return 'capability';
};

/**
 * Whether an FTS build failure should ABORT the analyze (throw before publish)
 * rather than degrade to a search-less-but-queryable index (#2658).
 *
 * Only an `integrity` failure on the atomic-swap path is fatal: there the graph
 * was built into a throwaway staging DB, so throwing abandons the staging file
 * and leaves the previous live index intact. On an in-place build
 * (`useAtomicSwap === false`: incremental, Windows default) the graph DML
 * already mutated the LIVE database, so there is nothing to roll back by
 * throwing — degrading to a queryable index with FTS marked unavailable is
 * strictly better than exiting mid-finalization over a dirty, partially-indexed
 * live DB. `capability` failures always degrade.
 */
export const ftsFailureIsFatal = (
  failureClass: FtsBuildFailureClass | undefined,
  useAtomicSwap: boolean,
): boolean => failureClass === 'integrity' && useAtomicSwap;

export interface BuildSearchIndexesResult {
  ok: boolean;
  error?: string;
  /** Present only when `ok` is false. See {@link FtsBuildFailureClass}. */
  failureClass?: FtsBuildFailureClass;
}

/**
 * Build + verify FTS indexes, catching any failure instead of letting it
 * propagate. `createSearchFTSIndexes` re-tokenizes every stored row on every
 * analyze run (see the `ponytail:` comment above) — a native LadybugDB
 * tokenizer error on a single pre-existing row (e.g. a "Failed calling
 * LOWER: Invalid UTF-8", #2544/#2546) must not discard an otherwise-
 * successful analyze's graph/embeddings work. The caller degrades keyword
 * search for this run instead, mirroring the existing FTS-extension-
 * unavailable degrade path in `run-analyze.ts`.
 */
export async function buildSearchIndexesOrDegrade(
  executeQuery: (cypher: string) => Promise<unknown[]>,
  options?: CreateSearchFTSIndexesOptions,
): Promise<BuildSearchIndexesResult> {
  try {
    await createSearchFTSIndexes(options);
    const missing = await verifySearchFTSIndexes(executeQuery);
    if (missing.length > 0) {
      // Structural incompleteness with no thrown error — treat as capability
      // (degrade), matching prior behavior; a broken *write* surfaces as a
      // thrown IO/checkpoint error below and is classified integrity there.
      const error = `missing indexes after build: ${missing.join(', ')}`;
      return { ok: false, error, failureClass: classifyFtsBuildError(error) };
    }
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error, failureClass: classifyFtsBuildError(error) };
  }
}
