/**
 * Full-Text Search via LadybugDB FTS
 *
 * Uses LadybugDB's built-in full-text search indexes for keyword-based search.
 * Always reads from the database (no cached state to drift).
 */

// tri-review Residual-1: `classifyFtsQueryError` now lives in lbug-adapter.ts
// (see its doc comment) so `queryFTS`'s own catch can share the SAME
// classifier instead of maintaining a second, independently-drifting copy
// for the identical `QUERY_FTS_INDEX` cypher call.
import { queryFTS, classifyFtsQueryError } from '../lbug/lbug-adapter.js';
import { normalizeFtsText } from '../lbug/csv-generator.js';
import { getExtensionCapabilities } from '../lbug/extension-loader.js';
import { redactPaths } from './fts-indexes.js';
import { FTS_INDEXES } from './fts-schema.js';
import {
  applyCjkSegmentationIfEnabled,
  MAX_CJK_SEGMENTATION_QUERY_LENGTH,
} from './cjk-segmentation.js';

export interface BM25SearchResult {
  filePath: string;
  score: number;
  rank: number;
  nodeIds?: string[];
}

export interface FTSSearchResponse {
  results: BM25SearchResult[];
  /** True when at least one FTS index query succeeded (index exists). */
  ftsAvailable: boolean;
  /**
   * Redacted (via {@link redactPaths}) message(s) from per-table
   * `QUERY_FTS_INDEX` calls that failed for a reason OTHER than "index
   * doesn't exist" (#2767) — a real query/connection error was previously
   * indistinguishable from a genuinely-missing index. Populated whenever ANY
   * table hit a non-benign error, regardless of whether other tables
   * succeeded, so a caller can always log it; whether to also surface it in
   * a client-facing warning is a caller decision (see `LocalBackend.query()`,
   * which only does so when every table failed).
   */
  nonBenignErrors?: string[];
}

/**
 * Optional-field shape rather than a discriminated union: this project builds
 * with `strict: false` (no `strictNullChecks`), under which TypeScript's
 * control-flow narrowing across an `if/else` on a boolean discriminant is
 * unreliable (verified empirically — narrows correctly under `strict: true`,
 * fails under `strict: false`). `rows` present means success; `rows` absent
 * means failure, with `benign`/`message` describing why.
 */
interface FTSQueryOutcome {
  rows?: Array<{ filePath: string; score: number; nodeId: string }>;
  benign?: boolean;
  message?: string;
}

/**
 * Execute a single FTS query via a custom executor (for MCP connection pool).
 * Returns a benign failure when the query fails because the index doesn't
 * exist (the normal, expected case), and a non-benign failure with the
 * captured message for any other error, so the caller can distinguish "zero
 * matches", "index missing", and "a real error occurred" instead of
 * collapsing the latter two into the same silent `null`.
 */
async function queryFTSViaExecutor(
  executor: (cypher: string, params: Record<string, any>) => Promise<any[]>,
  tableName: string,
  indexName: string,
  query: string,
  limit: number,
): Promise<FTSQueryOutcome> {
  const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', $query, conjunctive := false)
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;
  try {
    const rows = await executor(cypher, { query });
    return {
      rows: rows.map((row: any) => {
        const node = row.node || row[0] || {};
        const score = row.score ?? row[1] ?? 0;
        return {
          filePath: node.filePath || '',
          score: typeof score === 'number' ? score : parseFloat(score) || 0,
          nodeId: node.nodeId || node.id || '',
        };
      }),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { benign: classifyFtsQueryError(message) === 'missing-index', message };
  }
}

/**
 * Search using LadybugDB's built-in FTS (always fresh, reads from disk)
 *
 * Queries multiple node tables (File, Function, Class, Method) in parallel
 * and merges results by filePath, summing scores for the same file.
 *
 * @param query - Search query string
 * @param limit - Maximum results
 * @param repoId - If provided, queries will be routed via the MCP connection pool
 * @returns Ranked search results from FTS indexes
 */
export const searchFTSFromLbug = async (
  query: string,
  limit: number = 20,
  repoId?: string,
): Promise<FTSSearchResponse> => {
  // Applied once, up front, so every downstream branch searches with the
  // same text the index was built from (#2331/#2339) — index-time and
  // query-time text transforms must never diverge, since QUERY_FTS_INDEX
  // cannot derive a tokenizer from the index it queries. Composed in the
  // SAME order as the write path (csv-generator.ts's formatFtsDescription /
  // extractContent: normalizeFtsText(applyCjkSegmentationIfEnabled(text))):
  // CJK segmentation is no-op when disabled (default); normalizeFtsText
  // (collapsing \r\n\t to a space) applies unconditionally — it has no
  // per-character cost concern, unlike CJK segmentation, so it's not gated
  // by the length cap. Segmentation itself is skipped for pathologically
  // long queries (see MAX_CJK_SEGMENTATION_QUERY_LENGTH) — the query still
  // searches correctly, just without CJK sub-phrase segmentation.
  const searchQuery = normalizeFtsText(
    query.length <= MAX_CJK_SEGMENTATION_QUERY_LENGTH
      ? applyCjkSegmentationIfEnabled(query)
      : query,
  );
  const resultsByIndex: any[][] = [];
  let queriesSucceeded = 0;
  const nonBenignErrors: string[] = [];

  const ftsExtension = getExtensionCapabilities().find((c) => c.name === 'fts');
  if (ftsExtension && !ftsExtension.loaded) {
    // tri-review NEW-4 (applies to BOTH the MCP pool path and the CLI/pipeline
    // path — a /simplify altitude pass caught the original repoId-only guard
    // letting the CLI branch surface spurious "non-benign" errors for this
    // exact expected state, which the pool branch correctly stayed silent on):
    // extension-unavailable is an expected, already-diagnosed degraded-capability
    // state (#2374/#2658), not a per-table query error — every configured table
    // would throw the identical "function not defined" shape, which
    // classifyFtsQueryError correctly refuses to call benign "missing-index"
    // (it's a different, more serious condition). Skip the N redundant
    // QUERY_FTS_INDEX round-trips and N nonBenignErrors entries; ftsAvailable
    // stays false and ftsDegradedWarning() already reports this state
    // accurately from the same extension-capabilities registry.
  } else if (repoId) {
    // Use MCP connection pool via dynamic import
    // IMPORTANT: FTS queries run sequentially to avoid connection contention.
    // The MCP pool supports multiple connections, but FTS is best run serially.
    const poolMod = await import('../lbug/pool-adapter.js');
    const { executeParameterized } = poolMod;
    const executor = (cypher: string, params: Record<string, any>) =>
      executeParameterized(repoId, cypher, params);

    for (const { table, indexName } of FTS_INDEXES) {
      const outcome = await queryFTSViaExecutor(executor, table, indexName, searchQuery, limit);
      if (outcome.rows) {
        queriesSucceeded++;
        resultsByIndex.push(outcome.rows);
      } else if (!outcome.benign) {
        nonBenignErrors.push(redactPaths(outcome.message ?? 'Unknown FTS query error'));
      }
    }
  } else {
    // Use core lbug adapter (CLI / pipeline context) — also sequential for safety.
    // tri-review Residual-1: `queryFTS` itself only swallows a genuinely-missing
    // index (via the SAME classifyFtsQueryError this module re-exports); a
    // missing-table or real query error rethrows here — track it the same way
    // the MCP pool path does instead of a bare `catch {}` that dropped it.
    for (const { table, indexName } of FTS_INDEXES) {
      try {
        const result = await queryFTS(table, indexName, searchQuery, limit, false);
        queriesSucceeded++;
        resultsByIndex.push(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        nonBenignErrors.push(redactPaths(message));
      }
    }
  }

  const ftsAvailable = queriesSucceeded > 0;

  // Collect all node scores per filePath to track which nodes actually matched
  const fileNodeScores = new Map<string, Array<{ score: number; nodeId: string }>>();

  const addResults = (results: any[]) => {
    for (const r of results) {
      if (!fileNodeScores.has(r.filePath)) fileNodeScores.set(r.filePath, []);
      fileNodeScores.get(r.filePath)!.push({ score: r.score, nodeId: r.nodeId });
    }
  };

  for (const results of resultsByIndex) addResults(results);

  // Sum the top-3 highest-scoring nodes per file and collect their nodeIds.
  // Summing all nodes naively inflates scores for files with many mediocre
  // matches (e.g. test files) over files with a single highly-relevant symbol.
  const merged = new Map<string, { filePath: string; score: number; nodeIds: string[] }>();
  for (const [filePath, entries] of fileNodeScores) {
    const top3 = [...entries].sort((a, b) => b.score - a.score).slice(0, 3);
    merged.set(filePath, {
      filePath,
      score: top3.reduce((acc, e) => acc + e.score, 0),
      nodeIds: top3.map((e) => e.nodeId).filter((id) => id),
    });
  }

  // Sort by score descending and add rank
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    results: sorted.map((r, index) => ({
      filePath: r.filePath,
      score: r.score,
      rank: index + 1,
      nodeIds: r.nodeIds,
    })),
    ftsAvailable,
    ...(nonBenignErrors.length > 0 && { nonBenignErrors }),
  };
};
