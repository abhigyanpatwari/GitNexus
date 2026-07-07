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
