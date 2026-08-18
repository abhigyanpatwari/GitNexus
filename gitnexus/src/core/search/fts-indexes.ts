import {
  createFTSIndex,
  dropFTSIndex,
  indexRowName,
  indexRowTable,
  resolveGateRows,
  DEFAULT_FTS_STEMMER,
  type IndexCatalogSnapshot,
} from '../lbug/lbug-adapter.js';
import { getFtsCapability } from '../lbug/extension-loader.js';
import { classifyExtensionLoadError } from '../lbug/extension-load-error.js';
import { FTS_INDEXES, type FTSIndexDefinition } from './fts-schema.js';

/**
 * Strip filesystem paths from a LadybugDB error before it reaches the HTTP
 * `/api/search` and MCP query surfaces (#2374, PR #2375): the raw LOAD error
 * embeds the absolute extension path (username, home dir) which must not leak to
 * a network client. The error class words ("Failed to load library", "invalid
 * ELF header", "has not been installed") have no leading path separator and
 * survive. CLI/doctor/log surfaces keep the full path (they read the reason
 * directly, not through this function).
 *
 * tri-review Residual-3: every real message shape observed from LadybugDB
 * wraps the path in single quotes (`Failed to load library '<path>': ...`),
 * so a QUOTED path is redacted first, consuming through its closing quote —
 * spaces included (e.g. a Windows username like `alice smith`). The original
 * unquoted-stop-at-first-whitespace pattern still runs afterward as a
 * fallback for the rare case of a path appearing without quotes; that path's
 * own known limitation (partial redaction if it itself contains a space) is
 * unchanged, but is no longer the ONLY path this function knows how to redact.
 */
export const redactPaths = (reason: string): string =>
  reason
    .replace(/'((?:[A-Za-z]:\\|\/)[^']*)'/g, "'<path>'")
    .replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, '<path>');

/**
 * Resolved-repo/index identity a caller can attach to a degraded-FTS warning
 * (#2767) so a reader can tell whether *this* session even resolved the index
 * they expect, instead of guessing between a stale connection, a different
 * repo/branch, or a genuine build failure. MCP-`query`-only today — never
 * forwarded into the HTTP `/api/search` response (see that call site).
 */
export interface FtsWarningContext {
  repoName: string;
  branch?: string;
  indexedAt?: string;
  /** Already redacted by the caller (e.g. via {@link redactPaths} on a captured query error). */
  lastErrorRedacted?: string;
}

/** The repo/branch/indexed-at portion shared by both warning-context formatters below. */
const formatResolvedSuffix = (context: FtsWarningContext): string => {
  const branchSuffix = context.branch ? `/branch:${context.branch}` : '';
  const indexedSuffix = context.indexedAt ? `, indexed ${context.indexedAt}` : '';
  return `${context.repoName}${branchSuffix}${indexedSuffix}`;
};

const formatWarningContext = (context: FtsWarningContext): string => {
  const errorSuffix = context.lastErrorRedacted ? `; last error: ${context.lastErrorRedacted}` : '';
  return ` (resolved: ${formatResolvedSuffix(context)}${errorSuffix})`;
};

/**
 * Warning attached to search responses when BM25/FTS is degraded. Prefers the
 * live extension-load failure (with LadybugDB's real reason, #2374) over the
 * generic indexes-missing message, so "indexes exist but the extension broke"
 * is not misreported as missing indexes.
 *
 * `context`, when supplied, appends the resolved repo/branch/indexed-at (and
 * redacted query-error detail, if captured) so a CLI/MCP mismatch — or a real
 * query error masquerading as "indexes missing" — is visible in the warning
 * text itself (#2767). Optional and additive: omitting it reproduces today's
 * exact message.
 */
export const ftsDegradedWarning = (context?: FtsWarningContext): string => {
  const suffix = context ? formatWarningContext(context) : '';
  const fts = getFtsCapability();
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
      tail +
      suffix
    );
  }
  return (
    'FTS indexes missing — keyword search degraded. Run: gitnexus analyze --repair-fts ' +
    '(or gitnexus analyze --force) to rebuild indexes.' +
    suffix
  );
};

/**
 * Warning for when the FTS extension is loaded and indexes exist, but every
 * configured table's query failed for a real, non-benign reason (timeout,
 * connection reset, native fault) — as opposed to `ftsDegradedWarning`'s
 * missing-index case. `--repair-fts` will not fix a query/connection error,
 * so this deliberately does NOT suggest it: reusing the missing-index
 * message here would reproduce, for this cause, the exact misleading
 * "run --repair-fts" guidance #2767 itself was about (tri-review NEW-1).
 */
export const ftsQueryFailedWarning = (context: FtsWarningContext): string =>
  'FTS keyword search failed — every configured index query returned an error' +
  (context.lastErrorRedacted ? ` (${context.lastErrorRedacted})` : '') +
  '; results do not include keyword matches. This is not a missing-index ' +
  'condition — see server logs for details.' +
  ` (resolved: ${formatResolvedSuffix(context)})`;

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
  indexes?: readonly FTSIndexDefinition[];
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
 * Drop every configured FTS index ahead of any DML that mutates an FTS-indexed
 * table's rows: LadybugDB's FTS extension is not proven to survive a DETACH
 * DELETE against a table that still carries a live index from a prior run
 * (#2589) — dropping first removes that hazard entirely, regardless of whether
 * it also fixed a specific native inconsistency.
 *
 * CALLER OBLIGATION (#2841). `dropFTSIndex` still no-ops per index when the
 * index is ABSENT, but "unloadable" is no longer unconditionally tolerated: a
 * LIVE index plus an FTS extension that cannot load now THROWS, naming FTS and
 * its remedies, instead of reporting a drop that never happened and letting the
 * next insert/delete die at bind time with a message that never mentions FTS.
 * Nothing in the type system enforces that — callers must have already proven
 * the extension is loadable (`ensureFtsRowDmlSafe()` returning `true`, or a
 * direct `loadFTSExtension()`) before calling this. `run-analyze.ts` settles it
 * at the incremental extension gate and escalates to a full wipe-and-rebuild
 * write plan when the gate says no, so this function is only reached on the
 * branch where the drops can actually succeed.
 *
 * @param indexRows An {@link IndexCatalogSnapshot} the caller already read on
 * THIS connection with no index created or dropped since — the same freshness
 * contract, and the same one-shared-`SHOW_INDEXES`-read purpose, as the gates in
 * `lbug-adapter.ts`. Omit it to have the sweep read the catalog itself.
 */
export async function dropSearchFTSIndexes(
  indexRows?: IndexCatalogSnapshot,
  indexes: readonly FTSIndexDefinition[] = FTS_INDEXES,
): Promise<void> {
  // One catalog read for the whole sweep, decided PER CONFIGURED INDEX on
  // IDENTITY (#2841 cleanup review). `undefined` = the catalog could not be
  // read, which proves nothing — attempt every drop rather than skip a real one,
  // the same fail-closed reading `ensureFtsRowDmlSafe` applies to its own rows.
  //
  // Deliberately NOT an all-or-nothing early return keyed on index TYPE. That
  // shape put a second `=== 'FTS'` predicate over the same rows next to the
  // gate's `undefined || === 'FTS'` one, disagreeing on the polarity of an
  // unreadable index_type: the gate treats it as "might be FTS" and blocks,
  // while a bare `=== 'FTS'` here read it as "no FTS index anywhere" and skipped
  // the entire sweep. If the row shape ever changes while FTS still loads, the
  // gate would answer SAFE (surgical path), the sweep would drop nothing, and
  // `deleteNodesForFiles` would run against tables carrying live FTS indexes —
  // the exact #2589 hazard this sweep exists to prevent. Keying on identity
  // removes the polarity question entirely. Its stated justification was also
  // unreachable: the loop only ever drops the CONFIGURED `FTS_INDEXES` entries,
  // so an index left over from an older, differently-named set was never dropped
  // whether the sweep ran or not.
  const rows = await resolveGateRows(indexRows);
  for (const { table, indexName } of indexes) {
    // Skip only what the catalog POSITIVELY proves absent. Without this, a
    // machine whose FTS extension cannot load, analyzing a DB that never carried
    // an FTS index, pays one failed `CALL DROP_FTS_INDEX` per configured table on
    // EVERY incremental run — and each of those failures now costs a fresh
    // catalog read inside `dropFTSIndex`'s liveness guard, forever, with nothing
    // to heal (#2841 review). The `ensuredFTSIndexes` memo needs no clearing here
    // either: an index absent from the catalog cannot be memoized as ensured on
    // this connection, and `createSearchFTSIndexes` drops per index itself before
    // creating.
    const provenAbsent =
      rows !== undefined &&
      !rows.some((row) => indexRowTable(row) === table && indexRowName(row) === indexName);
    if (provenAbsent) continue;
    await dropFTSIndex(table, indexName);
  }
}

/** One configured index that could not be (re)built, and why. */
export interface FtsIndexBuildFailure {
  table: string;
  indexName: string;
  /** The raw LadybugDB message, unmodified — it is the only row-level evidence there is. */
  error: string;
}

/**
 * Build every configured FTS index, and keep going when one of them fails
 * (#2889).
 *
 * The loop used to let the first failure propagate, which made a single
 * untokenizable row far more expensive than it looks: `dropFTSIndex` has
 * already run for the failing table, so that table ends with NO index, and
 * every table after it in {@link FTS_INDEXES} order is never reached — on a
 * fresh build, or on the incremental path where `dropSearchFTSIndexes` cleared
 * them all up front, those tables end with no index either. One bad `Method`
 * row therefore cost keyword search on Namespace, Property, Record, Union,
 * Static and Variable as well, and `verifySearchFTSIndexes` never ran to say
 * so. The blast radius was an artifact of loop control flow, not of the data.
 *
 * Isolating per index bounds the damage to the table that actually holds the
 * bad row, and makes `--repair-fts` able to recover everything else. Failures
 * are returned rather than thrown so the caller can decide — degrade or abort —
 * with every failure in hand instead of only the first.
 */
export async function createSearchFTSIndexes(
  options?: CreateSearchFTSIndexesOptions,
): Promise<FtsIndexBuildFailure[]> {
  const stemmer = getSearchFTSStemmer();
  const failures: FtsIndexBuildFailure[] = [];
  for (const { table, indexName, properties } of options?.indexes ?? FTS_INDEXES) {
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
    try {
      await dropFTSIndex(table, indexName);
      await createFTSIndex(table, indexName, [...properties], stemmer);
    } catch (e) {
      // The message, never the Error: holding the Error would pin its stack and
      // whatever the native binding attached to it, for up to one per table.
      failures.push({ table, indexName, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    options?.onIndexReady?.(table, indexName);
  }
  return failures;
}

/**
 * One sentence naming every table that failed and why, e.g. `FTS index build
 * failed for 2 of 21 tables: Method.method_fts (Runtime exception: …), …`.
 *
 * Lives here rather than at the call sites because only this module knows the
 * denominator. Both the analyze degrade path and `--repair-fts` render it, so
 * one failure reads the same way whichever command produced it.
 *
 * Embeds the raw LadybugDB message UNREDACTED — CLI and log surfaces only.
 * Anything heading for a network response has to pass it through
 * {@link redactPaths} first, the same rule the query-side warnings follow.
 */
export const summarizeFtsIndexBuildFailures = (
  failures: readonly FtsIndexBuildFailure[],
  indexes: readonly FTSIndexDefinition[] = FTS_INDEXES,
): string =>
  `FTS index build failed for ${failures.length} of ${indexes.length} tables: ` +
  failures.map((f) => `${f.table}.${f.indexName} (${f.error})`).join(', ');

export async function verifySearchFTSIndexes(
  executeQuery: (cypher: string) => Promise<unknown[]>,
  indexes: readonly FTSIndexDefinition[] = FTS_INDEXES,
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
    const indexName = indexRowName(record);
    // LADYBUGDB-CONTRACT: `property_names` is the one SHOW_INDEXES column with a
    // single reader, so it has no shared accessor — see {@link IndexCatalogRow}
    // in lbug-adapter.ts for the full column list and the re-validation rule.
    // Unlike the gates, an unreadable shape here is safe: it reports the index as
    // not covering its columns, i.e. "missing", which degrades keyword search
    // loudly rather than passing a broken index off as verified.
    const propertyNames = record.property_names;
    if (typeof indexName !== 'string' || !Array.isArray(propertyNames)) continue;
    propsByIndex.set(
      indexName,
      propertyNames.filter((p): p is string => typeof p === 'string'),
    );
  }

  const missing: string[] = [];
  for (const { table, indexName, properties } of indexes) {
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
// Deliberately SPECIFIC (#2658 review L1): generic OS errors a capability/config
// failure can also carry — bare 'no such file or directory' (ENOENT, e.g. a
// missing FTS extension asset) and 'bad file descriptor'/'ebadf' — are NOT here,
// so an ambiguous failure degrades (the pre-#2658 safe behavior) instead of
// newly aborting the whole analyze. A genuine write/rename/checkpoint integrity
// failure still matches via 'error renaming' / 'io exception' / 'checkpoint'
// (the #2658 repro message "Error renaming … : No such file or directory" hits
// both 'io exception' and 'error renaming').
const FTS_INTEGRITY_SIGNATURES = [
  'io exception',
  'i/o error',
  'io error',
  'error renaming',
  'checkpoint',
  'corrupt',
  'no space',
  'enospc',
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
    // Verify ALWAYS runs, failures or not (#2889). Reporting must not jump the
    // queue ahead of verification: a partial build is exactly when "the other
    // tables are fine" needs proving rather than asserting, and a stale
    // name+content-only index is invisible to the build (it succeeds) yet still
    // means description search is broken (#2299).
    const failures = await createSearchFTSIndexes(options);
    const indexes = options?.indexes ?? FTS_INDEXES;
    const missing = await verifySearchFTSIndexes(executeQuery, indexes);
    if (failures.length === 0 && missing.length === 0) return { ok: true };

    // A table that failed to build is necessarily missing too — report it once,
    // with its reason, and keep `missing` for indexes nothing explains.
    const named = new Set(failures.map((f) => `${f.table}.${f.indexName}`));
    const unexplained = missing.filter((name) => !named.has(name));
    const error = [
      failures.length > 0 ? summarizeFtsIndexBuildFailures(failures, indexes) : '',
      // Structural incompleteness with no thrown error — classified capability
      // (degrade) below, matching prior behavior; a broken *write* surfaces as
      // a thrown IO/checkpoint error and is classified integrity there.
      unexplained.length > 0 ? `missing indexes after build: ${unexplained.join(', ')}` : '',
    ]
      .filter((part) => part.length > 0)
      .join('; ');

    // Classify per failure, not over the joined text: capability signatures are
    // checked first, so folding the messages together would let an untokenizable
    // row mask a genuinely broken write and downgrade an abort into a degrade.
    const failureClass = failures.some((f) => classifyFtsBuildError(f.error) === 'integrity')
      ? 'integrity'
      : classifyFtsBuildError(error);
    return { ok: false, error, failureClass };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error, failureClass: classifyFtsBuildError(error) };
  }
}
