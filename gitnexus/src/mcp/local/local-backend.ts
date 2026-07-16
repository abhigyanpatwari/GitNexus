/**
 * Local Backend (Multi-Repo)
 *
 * Provides tool implementations using local .gitnexus/ indexes.
 * Supports multiple indexed repositories via a global registry.
 * LadybugDB connections are opened lazily per repo on first query.
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import {
  initLbug,
  executeQuery,
  executeParameterized,
  closeLbug,
  isLbugReady,
} from '../../core/lbug/pool-adapter.js';
import { isValidQueryParams } from '../../core/lbug/query-params.js';
import { toDisplayLine } from './line-display.js';
import { isWalCorruptionError, WAL_RECOVERY_SUGGESTION } from '../../core/lbug/lbug-config.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at MCP server startup — crashes on unsupported Node ABI versions (#89)
// git utilities available if needed
// import { isGitRepo, getCurrentCommit, getGitRoot } from '../../storage/git.js';
import {
  parseDiffHunks,
  getCanonicalRepoRoot,
  getGitRoot,
  type FileDiff,
} from '../../storage/git.js';
import { realpathSync } from 'fs';
import {
  listRegisteredRepos,
  cleanupOldKuzuFiles,
  canonicalizePath,
  getStoragePaths,
  loadMeta,
  RegistryAmbiguousTargetError,
  type RegistryEntry,
  type BranchSummary,
} from '../../storage/repo-manager.js';
import {
  GroupService,
  type GroupToolPort,
  type GroupSymbolResolution,
  type GroupPdgFlowResult,
  type GroupPdgFlowHop,
} from '../../core/group/service.js';
import { resolveAtGroupMemberRepoPath } from '../../core/group/resolve-at-member.js';
import { collectBestChunks } from '../../core/embeddings/types.js';
import {
  DEFAULT_MCP_VECTOR_MAX_DISTANCE,
  getVectorMaxDistance,
} from '../../core/embeddings/config.js';
import {
  rankExactEmbeddingRows,
  type ExactEmbeddingRow,
} from '../../core/embeddings/exact-search.js';
import { EMBEDDING_TABLE_NAME, EMBEDDING_INDEX_NAME } from '../../core/lbug/schema.js';
import {
  getExactScanLimit,
  isVectorExtensionSupportedByPlatform,
} from '../../core/platform/capabilities.js';
import { PhaseTimer } from '../../core/search/phase-timer.js';
import { ftsDegradedWarning } from '../../core/search/fts-indexes.js';
import {
  cjkSegmentationModeMismatch,
  containsSegmentableCjkRun,
  getSearchFTSCjkSegmentation,
  isSupportedCjkSegmentationMode,
  MAX_CJK_SEGMENTATION_QUERY_LENGTH,
} from '../../core/search/cjk-segmentation.js';
import { checkStalenessAsync, checkCwdMatch } from '../../core/git-staleness.js';
import { logger } from '../../core/logger.js';
import {
  isLocalEmbeddingRuntimeBlockerMessage,
  isMissingLocalEmbeddingStackMessage,
} from '../../core/embeddings/runtime-support.js';
import {
  LIST_REPOS_DEFAULT_LIMIT,
  LIST_REPOS_MAX_LIMIT,
  EXPLAIN_DEFAULT_LIMIT,
  EXPLAIN_MAX_LIMIT,
  PDG_QUERY_DEFAULT_LIMIT,
  PDG_QUERY_MAX_LIMIT,
} from '../tools.js';
import { findImportCycles } from '../../core/graph/import-cycles.js';
import { decodeTaintPath } from '../../core/ingestion/taint/path-codec.js';
import { decodeReachingDefReason } from '../../core/ingestion/cfg/reaching-def-reason-codec.js';
import { EXTENSIONS } from '../../core/ingestion/import-resolvers/utils.js';
import {
  fnLineOf,
  isPdgDegradedLayerStatus,
  makePdgImpactErrorResult,
  makePdgLayerDegradedResult,
  pdgLayerStatus,
  pdgStampForMode,
  runImpactPDG,
  validateImpactMode,
  pdgBridgeEvidenceForImpact,
  betterBridgeEvidence,
  composeUnifiedPdgImpactResult,
  splitCalleeIds,
  type ImpactMode,
  type PdgImpactResult,
  type PdgImpactErrorResult,
  type PdgImpactTarget,
  type PdgBridgeOptions,
  type PdgBridgeEvidenceInfo,
  type PdgLayerStatus,
} from './pdg-impact.js';

/** Real source-file extensions (`.ts`, `.py`, …) from the resolver's list,
 *  excluding the empty entry and the `/index.*` forms — used to decide whether
 *  an `explain` target is a file path vs a (possibly dotted) symbol name. */
const SOURCE_FILE_EXTENSIONS: readonly string[] = EXTENSIONS.filter(
  (e) => e.startsWith('.') && !e.includes('/'),
);
/** A target is path-ish if it has a path separator or ends in a known source
 *  extension. A bare dotted symbol (`UserController.create`) is NOT path-ish. */
function looksLikeFilePath(target: string): boolean {
  if (/[\\/]/.test(target)) return true;
  const lower = target.toLowerCase();
  return SOURCE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Resolve a string tool param from its canonical name or legacy alias (#2175).
 * Returns the first NON-BLANK string of [canonical, legacy] — the canonical (new)
 * name is preferred when it carries a real value, otherwise the legacy value is used.
 * A blank/whitespace new value therefore does NOT clobber a valid legacy value (e.g. a
 * gradually-migrating client that always emits the new key, blank when unset). A
 * non-string value (the MCP envelope is not schema-validated, so clients can send any
 * JSON type) and an all-blank input resolve to `undefined`, so the caller returns a
 * friendly required-param error instead of throwing `TypeError` on `.trim()`.
 */
function resolveAliasString(canonical: unknown, legacy: unknown): string | undefined {
  for (const value of [canonical, legacy]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

interface StringAliasDefinition {
  canonical: string;
  aliases: readonly string[];
}

const TOOL_STRING_ALIASES: Readonly<Record<string, readonly StringAliasDefinition[]>> = {
  impact: [{ canonical: 'target', aliases: ['name', 'symbol'] }],
  context: [{ canonical: 'file_path', aliases: ['file'] }],
};

function normalizeToolParams(
  method: string,
  params: unknown,
): { params: Record<string, unknown> } | { error: string } {
  const input = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const definitions = TOOL_STRING_ALIASES[method];
  if (!definitions) return { params: input };

  const normalized = { ...input };
  for (const { canonical, aliases } of definitions) {
    const keys = [canonical, ...aliases];
    const supplied: Array<{ key: string; value: string }> = [];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      const value = input[key];
      // Internal CLI callers materialize omitted optional flags as undefined.
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value.trim()) {
        return { error: `MCP parameter ${method}.${key} must be a non-empty string.` };
      }
      supplied.push({ key, value: value.trim() });
    }
    const distinctValues = new Set(supplied.map(({ value }) => value));
    if (distinctValues.size > 1) {
      return {
        error: `Conflicting MCP parameters for ${method}.${canonical}: ${supplied
          .map(({ key }) => key)
          .join(', ')} must agree.`,
      };
    }

    for (const alias of aliases) delete normalized[alias];
    if (supplied.length > 0) normalized[canonical] = supplied[0].value;
  }

  if (
    method === 'impact' &&
    typeof normalized.target !== 'string' &&
    (typeof normalized.target_uid !== 'string' || !normalized.target_uid.trim())
  ) {
    return { error: 'MCP impact requires target, name, symbol, or target_uid.' };
  }
  return { params: normalized };
}

// AI context generation is CLI-only (gitnexus analyze)
// import { generateAIContextFiles } from '../../cli/ai-context.js';

/**
 * Quick test-file detection for filtering impact results.
 * Matches common test file patterns across all supported languages.
 */
export function isTestFilePath(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    p.includes('.test.') ||
    p.includes('.spec.') ||
    p.includes('__tests__/') ||
    p.includes('__mocks__/') ||
    p.includes('/test/') ||
    p.includes('/tests/') ||
    p.includes('/testing/') ||
    p.includes('/fixtures/') ||
    p.endsWith('_test.go') ||
    p.endsWith('_test.py') ||
    p.endsWith('_spec.rb') ||
    p.endsWith('_test.rb') ||
    p.includes('/spec/') ||
    p.includes('/test_') ||
    p.includes('/conftest.')
  );
}

/** Valid LadybugDB node labels for safe Cypher query construction */
export const VALID_NODE_LABELS = new Set([
  'File',
  'Folder',
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Community',
  'Process',
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
  'Route',
  'Tool',
]);

/** Valid relation types for impact analysis filtering */
export const VALID_RELATION_TYPES = new Set([
  'CALLS',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'METHOD_OVERRIDES',
  'OVERRIDES', // Legacy alias — dual-read for pre-rename indexes
  'METHOD_IMPLEMENTS',
  'ACCESSES',
  // Emitted by emit-references.ts / scope-resolution/graph-bridge/edges.ts and
  // already part of the default impact relTypes + context() incoming queries.
  // It was missing from this allowlist, so `impact({relationTypes:['USES']})`
  // silently filtered to [] and fell back to the full default traversal
  // (#2129/#1858 review F5). No IMPACT_RELATION_CONFIDENCE floor → 0.5 fallback,
  // matching the FETCHES / WRAPS / HANDLES_ROUTE precedent below.
  'USES',
  'HANDLES_ROUTE',
  'FETCHES',
  'HANDLES_TOOL',
  'ENTRY_POINT_OF',
  'WRAPS',
  // Emitted by the `di` pipeline phase (#2200 — DI collection injection,
  // consumer Class → implementer Class). Valid here for explicit
  // `relationTypes` filters, but deliberately NOT in the default impact()
  // relTypes nor the context() incoming/outgoing lists — traversal is opt-in,
  // like WRAPS/FETCHES. Also deliberately NO IMPACT_RELATION_CONFIDENCE entry
  // (WRAPS/FETCHES precedent): the 0.5 unknown-type floor applies there,
  // and the edges carry their own confidence (0.8) in the graph.
  'INJECTS',
]);

/**
 * Relation types the #1858 epistemic-boundary probe keys on. Kept as
 * module-level `readonly` arrays (not Sets) because computeEpistemicBoundary
 * binds them as Cypher query params (`r.type IN $heritage` / `IN $types`).
 * The heritage set is exactly the IMPACT_RELATION_CONFIDENCE 0.85 tier —
 * "statically verifiable, but the concrete binding past it is not".
 */
export const EPISTEMIC_HERITAGE_RELATION_TYPES: readonly string[] = [
  'IMPLEMENTS',
  'METHOD_IMPLEMENTS',
  'EXTENDS',
];
export const EPISTEMIC_CONSUMER_RELATION_TYPES: readonly string[] = ['CALLS', 'USES', 'ACCESSES'];

/**
 * Per-relation-type confidence floor for impact analysis.
 *
 * When the graph stores a relation with a confidence value, that stored
 * value is used as-is (it reflects resolution-tier accuracy from analysis
 * time).  This map provides the floor for each edge type when no stored
 * confidence is available, and is also used for display / tooltip hints.
 *
 * Rationale:
 *   CALLS / IMPORTS  – direct, strongly-typed references → 0.9
 *   EXTENDS          – class hierarchy, statically verifiable → 0.85
 *   IMPLEMENTS       – interface contract, statically verifiable → 0.85
 *   METHOD_OVERRIDES  – method override, statically verifiable → 0.85
 *   METHOD_IMPLEMENTS – interface method implementation, statically verifiable → 0.85
 *   HAS_METHOD       – structural containment → 0.95
 *   HAS_PROPERTY     – structural containment → 0.95
 *   ACCESSES         – field read/write, may be indirect → 0.8
 *   CONTAINS         – folder/file containment → 0.95
 *   (unknown type)   – conservative fallback → 0.5
 */
export const IMPACT_RELATION_CONFIDENCE: Readonly<Record<string, number>> = {
  CALLS: 0.9,
  IMPORTS: 0.9,
  EXTENDS: 0.85,
  IMPLEMENTS: 0.85,
  METHOD_OVERRIDES: 0.85,
  METHOD_IMPLEMENTS: 0.85,
  HAS_METHOD: 0.95,
  HAS_PROPERTY: 0.95,
  ACCESSES: 0.8,
  CONTAINS: 0.95,
};

/**
 * Return the confidence floor for a given relation type.
 * Falls back to 0.5 for unknown types so they are not silently elevated.
 */
const confidenceForRelType = (relType: string | undefined): number =>
  IMPACT_RELATION_CONFIDENCE[relType ?? ''] ?? 0.5;

/**
 * Structured logging for *swallowed* query failures — replaces empty catch
 * blocks. The level reflects telemetry severity, NOT a promise about the
 * caller: most callers catch the failure and degrade to a genuinely safe
 * fallback (a usable result, usually with a caller-visible `partial`/`ftsUsed`
 * flag), so these are not operation-level errors and must not log at `error`:
 *
 *  - A benign missing optional table/label/column — a repo analyzed without
 *    processes/communities, or a pre-v3 PDG index lacking the `calleeIds`
 *    column — is a normal configuration, not a failure. Logged at `debug`
 *    (suppressed at the default `info` level; surfaced only when troubleshooting).
 *  - Any other swallowed failure is an unexpected-but-handled degradation:
 *    logged at `warn` so it stays observable without raising a false `error`
 *    alarm that would drown genuine, operation-aborting failures.
 *
 * `error` is intentionally NOT used here — it is reserved for failures that
 * actually abort an operation, which log directly rather than through this
 * best-effort-degradation helper.
 *
 * Contract for callers (#2283 review): only route a failure here when the
 * caller ALSO surfaces the degradation in its result (a `partial` flag,
 * `failed_files`, `traversalComplete:false`, …). A mutating or safety-critical
 * path that would otherwise report success/clean (e.g. `rename` apply, the
 * `detect_changes` safety gate) MUST set that result-level signal — `warn`
 * alone is not a substitute for an honest result.
 */
function logQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (isBenignMissingTableError(err)) {
    logger.debug({ context, err: msg }, 'GitNexus query skipped (missing optional data)');
    return;
  }
  logger.warn({ context, err: msg }, 'GitNexus query failed (degraded)');
}

/**
 * A "missing table/label/relation" prepare error is benign for the query tool's
 * best-effort enrichment: a repo analyzed without processes or communities simply
 * has no `Process`/`Community` tables, so the `STEP_IN_PROCESS` / `MEMBER_OF`
 * enrichment queries fail to prepare. That is a normal configuration, NOT a
 * degraded result — it must not raise the `partial` flag (which callers would
 * then learn to ignore). Real failures (timeouts, locks, native faults) do.
 */
function isBenignMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  // The `not (defined|found)` arm is scoped to a schema object (table/label/
  // rel/column/property), mirroring lbug-adapter's isMissingColumnError
  // (`/(table|column|property).*not found/i`): an unscoped "not found" matched
  // operation failures like `rg: not found` (ripgrep absent) or `Symbol not
  // found`, which this helper would then silently demote to `debug` (#2283).
  return /does not exist|no such (table|label|rel)|unknown (table|label)|(table|label|rel|column|property)[^\n]*\bnot (defined|found)\b/i.test(
    msg,
  );
}

const isReadOnlyDbError = (err: unknown): boolean => {
  // Walk the `cause` chain (bounded) so a wrapped read-only error (e.g. the
  // pool adapter's `{ cause }` wrapper) is still detected here — this is the
  // copy the MCP cypher handler uses to surface its curated read-only message
  // (#2068 follow-up). Mirrors lbug-adapter's isReadOnlyDbError.
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    const msg = cur instanceof Error ? cur.message : String(cur);
    if (/read-only database/i.test(msg)) return true;
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
};

/**
 * Per-query latency telemetry for production aggregation (#553).
 *
 * Logged at `debug` level — timing is observability/telemetry, not an
 * error. Operators wanting per-query timing set `GITNEXUS_LOG_LEVEL=debug`
 * (or equivalent). Emitting at `error` level (the original migration
 * artifact) caused alerting rules to fire on every successful query and
 * inflated stderr noise for every MCP/CLI invocation.
 *
 * Emitted via the project logger which routes to stderr — never stdout —
 * because the MCP stdio transport uses stdout exclusively for JSON-RPC
 * responses (#324) and the CLI e2e test `tool output goes to stdout via
 * fd 1` asserts stdout parses cleanly as JSON.
 */
function logQueryTiming(query: string, phases: Record<string, number>): void {
  const totalMs = phases.wall ?? Object.values(phases).reduce((a, b) => a + b, 0);
  const truncated = query.length > 80 ? `${query.slice(0, 80)}…` : query;
  logger.debug({ query: truncated, totalMs, phases }, 'GitNexus query timing');
}

export interface CodebaseContext {
  projectName: string;
  stats: {
    fileCount: number;
    functionCount: number;
    communityCount: number;
    processCount: number;
  };
}

interface RepoHandle {
  id: string; // unique key = repo name (basename)
  name: string;
  repoPath: string;
  storagePath: string;
  lbugPath: string;
  indexedAt: string;
  lastCommit: string;
  remoteUrl?: string;
  stats?: RegistryEntry['stats'];
  /** Primary/flat branch name, when known (#2106). */
  branch?: string;
  /** Pinned `--branch` sub-indexes available for this repo, distinct from the flat workspace slot (#2106/#2354). */
  branches?: BranchSummary[];
}

/** Resolve symlinks for path comparison; falls back to path.resolve on error.
 * Uses `realpathSync.native` (not the pure-JS `realpathSync`) so that Windows
 * 8.3 short names (e.g. RUNNER~1 → runneradmin) are expanded to long form,
 * matching the output of `git rev-parse --show-toplevel`. */
function tryRealpath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Resolve the git diff cwd for detect_changes, auto-detecting linked worktrees.
 *
 * When `launchCwd` is a linked worktree of the same canonical repository as
 * `repoPath` (i.e. `getGitRoot(launchCwd)` differs from `repoPath` but both
 * share the same `getCanonicalRepoRoot`), returns the worktree's git root so
 * that `git diff` sees the correct working directory and index.
 *
 * Returns `repoPath` unchanged in all other cases (non-worktree, git
 * unavailable, unrelated repo).
 *
 * Extracted as a module-level export so tests can pass any `launchCwd` instead
 * of relying on `process.cwd()`, which is fixed to the server launch directory
 * and cannot be changed mid-process.
 */
export function resolveWorktreeCwd(repoPath: string, launchCwd: string): string {
  try {
    // Verify repoPath is a git root before comparing against its canonical
    // root. If getGitRoot returns a different path, repoPath is an arbitrary
    // subdirectory — skip both the linked-worktree guard and auto-detection
    // and fall through to the repoPath fallback.
    const repoGitRoot = getGitRoot(repoPath);
    const repoCanonical =
      repoGitRoot && tryRealpath(repoGitRoot) === tryRealpath(repoPath)
        ? getCanonicalRepoRoot(repoPath)
        : null;

    // Early exit: if repoPath is a linked worktree (differs from its canonical
    // main-checkout root), return it unchanged. Do NOT override it with the
    // server's launch directory — that would silently replace the explicitly-
    // resolved worktree index with the main checkout.
    //
    // getCanonicalRepoRoot returns the main-checkout path for both the checkout
    // and all linked worktrees:
    //   repoPath === canonical → main checkout (auto-detect may fire below)
    //   repoPath !== canonical → linked worktree (return as-is)
    if (repoCanonical && tryRealpath(repoPath) !== tryRealpath(repoCanonical)) {
      return repoPath;
    }

    const launchGitRoot = getGitRoot(launchCwd);
    if (launchGitRoot) {
      // Normalise via realpathSync before comparing so macOS /var → /private/var
      // symlinks (and Windows 8.3 short names) don't create false mismatches.
      const realLaunch = tryRealpath(launchGitRoot);
      const realRepo = tryRealpath(repoPath);
      if (realLaunch !== realRepo) {
        const launchCanonical = getCanonicalRepoRoot(launchCwd);
        // Use tryRealpath on both canonical values for cross-platform safety.
        if (
          launchCanonical &&
          repoCanonical &&
          tryRealpath(launchCanonical) === tryRealpath(repoCanonical)
        ) {
          return launchGitRoot;
        }
      }
    }
  } catch {
    // Best-effort; fall through to repoPath.
  }
  return repoPath;
}

/**
 * Length of the path-derived suffix appended to a colliding repo id.
 * Exported so tests can pin the suffix shape without re-deriving the
 * literal; see `assignRepoId()` and the hashed-id resolution tier (#1658).
 *
 * Note: base64url is an *encoding*, not a hash — it preserves byte order, so
 * two paths that share a long common prefix (sibling clones under one parent)
 * collapse to the same sliced suffix. `assignRepoId()` keeps the legacy
 * base64url suffix only for the first colliding duplicate (id compatibility)
 * and falls back to a content hash of the resolved path on a real collision
 * (#2054).
 */
export const REPO_ID_HASH_LENGTH = 6;

interface TraceParams {
  from?: string;
  from_uid?: string;
  from_file?: string;
  to?: string;
  to_uid?: string;
  to_file?: string;
  maxDepth?: number;
  includeTests?: boolean;
}

interface ImpactParams {
  target: string;
  target_uid?: string;
  file_path?: string;
  kind?: string;
  direction: 'upstream' | 'downstream';
  /**
   * Blast-radius engine (KTD1/KTD5). Absent / `undefined` / `'callgraph'` →
   * the unchanged inter-procedural symbol→symbol BFS. `'pdg'` → the opt-in,
   * intra-procedural Program Dependence Graph traversal (`_runImpactPDG`).
   * Validated in `_impactImpl`; any other value is a hard `{ error }`.
   */
  mode?: ImpactMode;
  /**
   * Statement anchor for `mode:'pdg'` (1-based source line). When provided, the
   * PDG traversal seeds the dependence slice on the BasicBlock(s) at THIS line
   * within the target symbol — answering "what statements depend on the code at
   * line N?" — instead of the whole-symbol seed (which is empty for a function,
   * since its intra-procedural reach stays inside its own blocks). Only
   * meaningful with `mode:'pdg'`; rejected for `mode:'callgraph'`.
   */
  line?: number;
  maxDepth?: number;
  crossDepth?: number;
  relationTypes?: string[];
  includeTests?: boolean;
  minConfidence?: number;
  limit?: number;
  offset?: number;
  summaryOnly?: boolean;
}

/** One route in an `api_impact` result. `executionFlows` are process names. */
interface ApiImpactRoute {
  route: string;
  method: string | null;
  handler: string;
  responseShape: { success: string[]; error: string[] };
  middleware: string[];
  middlewareDetection?: 'partial';
  middlewareNote?: string;
  consumers: Array<{ name: string; file: string; accesses: string[]; attributionNote?: string }>;
  mismatches?: Array<{
    consumer: string;
    field: string;
    reason: string;
    confidence: 'high' | 'low';
  }>;
  executionFlows: string[];
  impactSummary: {
    directConsumers: number;
    affectedFlows: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    warning?: string;
  };
}

/**
 * `api_impact` is polymorphic by match count: a single matched route returns the
 * route object directly; two or more return the wrapped `{ routes, total }`
 * form; any guard failure returns `{ error }`.
 */
type ApiImpactResult =
  | ApiImpactRoute
  | { routes: ApiImpactRoute[]; total: number }
  | { error: string };

/**
 * One repository entry as returned by {@link LocalBackend.listRepos} and in each
 * `list_repos` page. Named so the `listRepos`/`listReposPage` return types read
 * clearly instead of an opaque `Awaited<ReturnType<…>>` expression.
 */
export interface RepoListing {
  name: string;
  path: string;
  indexedAt: string;
  lastCommit: string;
  remoteUrl?: string;
  stats?: any;
  staleness?: { commitsBehind: number; hint?: string };
  siblings?: Array<{ name: string; path: string; lastCommit: string }>;
  /** Primary/flat branch name, when known (#2106). */
  branch?: string;
  /** Pinned `--branch` sub-indexes available for this repo, distinct from the flat workspace slot (#2106/#2354). */
  branches?: Array<Omit<BranchSummary, 'stats'>>;
}

/** Continuation metadata for the paginated `list_repos` MCP tool (#2119). */
export interface ListReposPagination {
  /** Total repositories across all pages. */
  total: number;
  /** Effective page size used (equals the requested limit; out-of-range is rejected, not clamped). */
  limit: number;
  /** Offset this page started at. */
  offset: number;
  /** Number of repositories actually returned in this page. */
  returned: number;
  /** True when more repositories remain past this page. */
  hasMore: boolean;
  /** Offset to request next; present only when `hasMore` is true. */
  nextOffset?: number;
}

/**
 * Validate and normalise `list_repos` pagination arguments.
 *
 * @internal Exported for unit testing; not part of the public API surface.
 *
 * There is NO MCP-SDK-level enforcement of a tool's advertised `inputSchema`
 * (the SDK validates only the JSON-RPC envelope), and `callTool` is reachable
 * directly, so the backend is the real validation boundary. Malformed values —
 * non-number, `NaN`, non-integer, `limit < 1`, `limit > maxLimit`, or
 * `offset < 0` — are REJECTED with a clear error. `limit` is bounded but NOT
 * silently clamped: an over-max value throws (symmetric with the other bounds)
 * so a client never receives a smaller page than it asked for without knowing.
 * An omitted value (only `undefined`) falls back to the default.
 */
export function parseListReposPagination(
  params: { limit?: unknown; offset?: unknown } | null | undefined,
  opts: { defaultLimit: number; maxLimit: number },
): { limit: number; offset: number } {
  const requireInt = (value: unknown, field: string, min: number, max?: number): number => {
    const valid =
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= min &&
      (max === undefined || value <= max);
    if (!valid) {
      const bound = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
      throw new Error(
        `list_repos: "${field}" must be an integer ${bound} (received ${JSON.stringify(value)})`,
      );
    }
    return value;
  };

  let limit = opts.defaultLimit;
  if (params?.limit !== undefined) {
    limit = requireInt(params.limit, 'limit', 1, opts.maxLimit);
  }

  let offset = 0;
  if (params?.offset !== undefined) {
    offset = requireInt(params.offset, 'offset', 0);
  }

  return { limit, offset };
}

export class LocalBackend {
  private repos: Map<string, RepoHandle> = new Map();
  private contextCache: Map<string, CodebaseContext> = new Map();
  private initializedRepos: Set<string> = new Set();
  private reinitPromises: Map<string, Promise<void>> = new Map();
  private lastStalenessCheck: Map<string, number> = new Map();
  // Last meta.indexedAt observed for an open pool, keyed by lbugPath. Keyed by
  // pool (not stored on the handle) because branch handles are produced fresh
  // by applyBranchScope on every resolveRepo call, so mutating the handle would
  // not persist across calls and the staleness check would reinit forever
  // (#2106).
  private lastObservedIndexedAt: Map<string, string> = new Map();
  private groupToolSvc: GroupService | null = null;
  /**
   * One-shot stderr warnings for sibling-clone drift, keyed by
   * `${repoId}|${cwdGitRoot}`. Without this guard every tool call
   * from inside a sibling clone would print the same warning,
   * making MCP stderr unreadable.
   */
  private warnedSiblingDrift: Set<string> = new Set();

  /**
   * One-shot stderr warning for the VECTOR-extension fallback. Without this
   * guard the diagnostic would fire on every `semanticSearch()` call on
   * platforms where the extension is unsupported (e.g. Windows), making MCP
   * stderr noisy per DoD §2.8.
   */
  private warnedVectorUnsupported = false;

  /**
   * One-shot warning when a pruned or Node-unloadable optional embedding stack
   * (#2370/#2372) forces semantic search to fall back to BM25 — so the
   * degradation is visible once instead of silent.
   */
  private warnedMissingEmbeddingStack = false;

  /**
   * Cross-repo group tools (CLI). Shares logic with MCP `group_*` handlers.
   */
  getGroupService(): GroupService {
    if (!this.groupToolSvc) {
      const port: GroupToolPort = {
        resolveRepo: (p) => this.resolveRepo(p),
        impact: (r, p) => this.impact(r as RepoHandle, p),
        query: (r, p) => this.query(r as RepoHandle, p),
        impactByUid: (id, uid, d, o) => this.impactByUid(id, uid, d, o),
        context: (r, p) => this.context(r as RepoHandle, p),
        trace: (r, p) => this.traceForGroup(r as RepoHandle, p),
        resolveSymbol: (r, q) => this.resolveSymbolForGroup(r as RepoHandle, q),
        pdgFlows: (r, anchor, opts) => this.pdgFlowsForGroup(r as RepoHandle, anchor, opts),
      };
      this.groupToolSvc = new GroupService(port);
    }
    return this.groupToolSvc;
  }

  /**
   * Adapt local `trace` to the group port. The assembled group/cross-repo trace
   * presents 1-based endpoints (via resolveSymbolForGroup), so convert the hop
   * lines here too — otherwise one response mixes 1-based endpoints with 0-based
   * hops (#2380). Single-repo `trace` dispatches directly (not through this
   * port) and stays 0-based (documented full-parity follow-up).
   */
  private async traceForGroup(repo: RepoHandle, params: TraceParams): Promise<unknown> {
    const result = await this.trace(repo, params);
    const hops = (result as { hops?: Array<{ startLine?: number | null }> }).hops;
    if (Array.isArray(hops)) {
      for (const hop of hops) {
        hop.startLine = toDisplayLine(hop.startLine);
      }
    }
    return result;
  }

  /**
   * Adapt the shared symbol resolver to the GroupToolPort contract. Used by the
   * cross-repo trace path to locate which member repo an endpoint lives in and
   * recover its node id (== bridge `Contract.symbolUid`).
   */
  private async resolveSymbolForGroup(
    repo: RepoHandle,
    query: { name?: string; uid?: string; file_path?: string },
  ): Promise<GroupSymbolResolution> {
    await this.ensureInitialized(repo);
    const outcome = await this.resolveSymbolCandidates(
      repo,
      { uid: query.uid, name: query.name },
      { file_path: query.file_path },
    );
    if (outcome.kind === 'ok') {
      const s = outcome.symbol;
      return {
        kind: 'ok',
        symbol: {
          id: s.id,
          name: s.name,
          type: s.type,
          filePath: s.filePath,
          startLine: toDisplayLine(s.startLine),
          endLine: toDisplayLine(s.endLine),
        },
      };
    }
    if (outcome.kind === 'ambiguous') {
      return {
        kind: 'ambiguous',
        candidates: outcome.candidates.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          filePath: c.filePath,
          startLine: toDisplayLine(c.startLine),
        })),
      };
    }
    return { kind: 'not_found' };
  }

  /**
   * Intra-procedural REACHING_DEF data-flow for a single anchor symbol, adapted
   * to the GroupToolPort contract. Reuses the same anchor + `flows` query as the
   * `pdg_query` tool. `available:false` (not an error) when the repo has no PDG
   * `flows` layer, so the cross-repo trace degrades to call-level hops.
   */
  private async pdgFlowsForGroup(
    repo: RepoHandle,
    anchor: { name?: string; uid?: string; file_path?: string },
    opts: { limit?: number },
  ): Promise<GroupPdgFlowResult> {
    try {
      await this.ensureInitialized(repo);
      return await this._pdgFlowsForGroupImpl(repo, anchor, opts);
    } catch {
      // Enrichment is auxiliary — never let a PDG query failure fail the trace.
      return { available: false, hops: [] };
    }
  }

  /**
   * Intra-procedural REACHING_DEF data-flow within the anchor symbol's block
   * span. Reuses the same anchored, bind-param-only `flows` query as
   * `pdg_query` (no rel-property index ⇒ the BasicBlock id-prefix + line-span
   * anchor IS the bound). The anchor is resolved by UID when available (the
   * boundary symbol is known precisely), avoiding the name-ambiguity the
   * by-name `resolveBlockAnchor` path can hit. Data flow never crosses the repo
   * boundary — this only describes how values move toward the boundary call
   * inside one function.
   */
  private async _pdgFlowsForGroupImpl(
    repo: RepoHandle,
    anchor: { name?: string; uid?: string; file_path?: string },
    opts: { limit?: number },
  ): Promise<GroupPdgFlowResult> {
    const rawLimit = opts.limit ?? PDG_QUERY_DEFAULT_LIMIT;
    const limit =
      Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= PDG_QUERY_MAX_LIMIT
        ? rawLimit
        : PDG_QUERY_DEFAULT_LIMIT;

    // Meta probe: layer present iff the flows cap is stamped. `false` is a
    // definitive absence (degrade to call-level); `undefined` is unreadable
    // meta (fall through and infer presence from rows found).
    const pdgStamped = await pdgStampForMode(repo.lbugPath, 'flows');
    if (pdgStamped === false) return { available: false, hops: [] };

    // Resolve the anchor symbol (UID is precise; fall back to name/file).
    const resolved = await this.resolveSymbolCandidates(
      repo,
      { uid: anchor.uid, name: anchor.name },
      { file_path: anchor.file_path },
    );
    if (resolved.kind !== 'ok') {
      // Layer may exist but we couldn't anchor — report availability from the
      // stamp so the caller's note reflects the layer, not the miss.
      return { available: pdgStamped === true, hops: [] };
    }
    const sym = resolved.symbol;

    // Same span-anchored clause as resolveBlockAnchor's symbol branch: the
    // BasicBlock startLine is 1-based vs the 0-based symbol span, so shift both
    // bounds +1. `idPrefix`/`symStart`/`symEnd` are bind params; the edge type
    // is a hardcoded literal — no user string is ever interpolated.
    const hasSpan =
      typeof sym.startLine === 'number' &&
      typeof sym.endLine === 'number' &&
      sym.endLine >= sym.startLine;
    const idPrefix = `BasicBlock:${sym.filePath}:`;
    const anchorClause = hasSpan
      ? 'a.id STARTS WITH $idPrefix AND a.startLine >= $symStart AND a.startLine <= $symEnd'
      : 'a.id STARTS WITH $idPrefix';
    const queryParams: Record<string, unknown> = hasSpan
      ? { idPrefix, symStart: sym.startLine + 1, symEnd: sym.endLine + 1 }
      : { idPrefix };

    const rows = await executeParameterized(
      repo.lbugPath,
      `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
       WHERE r.type = 'REACHING_DEF' AND ${anchorClause}
       RETURN a.startLine AS defLine, b.startLine AS useLine, b.text AS useText, r.reason AS reason
       ORDER BY useLine, defLine, reason
       LIMIT ${limit + 1}`,
      queryParams,
    );

    const truncated = rows.length > limit;
    const capped = truncated ? rows.slice(0, limit) : rows;
    const hops: GroupPdgFlowHop[] = capped.map((r: Record<string, unknown>) => ({
      // Number()/String() coerce the LadybugDB object/tuple cell; a bare
      // `as number` cast on a nullish cell would surface NaN downstream.
      line: Number(r.useLine ?? r[1] ?? 0),
      text: String(r.useText ?? r[2] ?? '').trim(),
      variable: decodeReachingDefReason(String(r.reason ?? r[3] ?? '')).name || undefined,
    }));

    const available = pdgStamped === true || hops.length > 0;
    return {
      available,
      ...(hops[0]?.variable ? { variable: hops[0].variable } : {}),
      hops,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /** Close all pooled LadybugDB connections (CLI one-shot; optional for long-lived MCP). */
  async dispose(): Promise<void> {
    await closeLbug();
  }

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize from the global registry.
   * Returns true if at least one repo is available.
   */
  async init(): Promise<boolean> {
    await this.refreshRepos();
    return this.repos.size > 0;
  }

  /**
   * Re-read the global registry and update the in-memory repo map.
   * New repos are added, existing repos are updated, removed repos are pruned.
   * LadybugDB connections for removed repos are NOT closed (they idle-timeout naturally).
   */
  private async refreshRepos(): Promise<void> {
    const entries = await listRegisteredRepos({ validate: true });

    // Build the next map from scratch and swap it in atomically. Mutating the
    // live map in place let stale entries influence fresh id assignment: a
    // bare-name id, once handed to the first registry entry, stuck to it across
    // refreshes and reorders, and colliding path suffixes silently overwrote
    // each other so sibling clones disappeared from `list_repos` (#2054).
    const nextRepos = new Map<string, RepoHandle>();
    const nextContext = new Map<string, CodebaseContext>();
    const assigned = new Map<string, string>(); // id -> resolved repo path

    // Assign ids over a path-sorted view so a registered clone always gets the
    // same id regardless of the registry's on-disk order: the bare name and
    // each path-derived suffix become a pure function of the resolved-path set,
    // not of iteration order, so a memorized id can't drift to a different
    // clone after a registry reorder (#2067 follow-up).
    const ordered = [...entries].sort((a, b) => {
      const ra = path.resolve(a.path);
      const rb = path.resolve(b.path);
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });

    for (const entry of ordered) {
      // path.resolve (not canonicalizePath) matches the pre-#2054 collision
      // check and keeps refreshRepos free of mockable deps on the hot init
      // path. registerRepo writes path.resolve'd paths (not realpath), and
      // resolveRepoFromCache canonicalizes both sides when matching by path, so
      // keying id assignment on path.resolve here is consistent and correct.
      const resolved = path.resolve(entry.path);
      const id = this.assignRepoId(entry.name, entry.path, resolved, assigned);

      const storagePath = entry.storagePath;
      const lbugPath = path.join(storagePath, 'lbug');

      // Clean up any leftover KuzuDB files from before the LadybugDB migration.
      // If kuzu exists but lbug doesn't, warn so the user knows to re-analyze.
      const kuzu = await cleanupOldKuzuFiles(storagePath);
      if (kuzu.found && kuzu.needsReindex) {
        logger.error(
          `GitNexus: "${entry.name}" has a stale KuzuDB index. Run: gitnexus analyze ${entry.path}`,
        );
      }

      const handle: RepoHandle = {
        id,
        name: entry.name,
        repoPath: entry.path,
        storagePath,
        lbugPath,
        indexedAt: entry.indexedAt,
        lastCommit: entry.lastCommit,
        remoteUrl: entry.remoteUrl,
        stats: entry.stats,
        branch: entry.branch,
        branches: entry.branches,
      };

      nextRepos.set(id, handle);

      // Build lightweight context (no LadybugDB needed)
      const s = entry.stats || {};
      nextContext.set(id, {
        projectName: entry.name,
        stats: {
          fileCount: s.files || 0,
          functionCount: s.nodes || 0,
          communityCount: s.communities || 0,
          processCount: s.processes || 0,
        },
      });
    }

    // Prune per-clone pool state for databases that are no longer registered.
    // The LadybugDB pool and the init/staleness/reinit maps are keyed by the
    // immutable lbugPath (see ensureInitialized), so a repo id that merely
    // moves to a different clone needs NO eviction — distinct clones have
    // distinct lbugPaths and can never share a pool entry, which is what closes
    // the resolve→query wrong-clone window for good (#2067). Only a path that
    // dropped out of the registry must release its pooled connection + state.
    const liveLbugPaths = new Set([...nextRepos.values()].map((h) => h.lbugPath));
    // Branch pools (opened on demand by applyBranchScope) are NOT in this.repos
    // — branch handles are minted fresh and discarded — so add every registered
    // branch's lbugPath to the live set. Pure string work over the already-in-
    // memory registry snapshot; no disk I/O on this hot path (#2106 R3).
    for (const entry of entries) {
      for (const b of entry.branches ?? []) {
        liveLbugPaths.add(getStoragePaths(entry.path, b.branch).lbugPath);
      }
    }
    // initializedRepos is the authoritative set of OPENED pool keys (flat AND
    // branch); union it with the previously-known flat handles so an orphaned
    // branch pool (e.g. after `clean --branch` removes its summary) is closed
    // and forgotten too, not just flat handles.
    const knownKeys = new Set<string>([
      ...[...this.repos.values()].map((h) => h.lbugPath),
      ...this.initializedRepos,
    ]);
    for (const key of knownKeys) {
      if (liveLbugPaths.has(key)) continue;
      this.initializedRepos.delete(key);
      this.lastStalenessCheck.delete(key);
      this.lastObservedIndexedAt.delete(key);
      this.reinitPromises.delete(key);
      closeLbug(key).catch(() => {});
    }

    this.repos = nextRepos;
    this.contextCache = nextContext;
  }

  /**
   * Assign a collision-free in-memory id for a registered repo.
   *
   * - Unique name → the bare lowercased name.
   * - Duplicate name → a path-derived suffix. The *first* colliding clone keeps
   *   the legacy `base64url(path)` suffix so ids generated before #2054 still
   *   resolve (the #1658 hashed-id tier). base64url is an encoding, not a hash:
   *   it preserves byte order, so sibling clones under one parent (e.g.
   *   `.../REPO_2` and `.../REPO_3`) yield identical leading characters and thus
   *   the same sliced suffix. Any further collision therefore falls back to a
   *   content hash of the *resolved* path (order-insensitive), extended
   *   deterministically until unique.
   *
   * `assigned` maps every id handed out in this refresh to its resolved path,
   * so a candidate is "free" when it is unused or already owned by this exact
   * path. This method records its own assignment into `assigned` before
   * returning, so the map-update is the function's invariant, not a caller
   * obligation. A returned id never overwrites a different path's handle (#2054).
   */
  private assignRepoId(
    name: string,
    repoPath: string,
    resolved: string,
    assigned: Map<string, string>,
  ): string {
    const base = name.toLowerCase();
    const free = (id: string): boolean => {
      const owner = assigned.get(id);
      return owner === undefined || owner === resolved;
    };
    // Record the assignment so subsequent entries in the same refresh see this
    // id as taken (the function owns its own invariant).
    const claim = (id: string): string => {
      assigned.set(id, resolved);
      return id;
    };

    if (free(base)) return claim(base);

    // Legacy suffix from the *raw* path — kept byte-for-byte so the first
    // colliding duplicate keeps the id it had before #2054 (#1658 tier).
    const legacy = `${base}-${Buffer.from(repoPath)
      .toString('base64url')
      .slice(0, REPO_ID_HASH_LENGTH)
      .toLowerCase()}`;
    if (free(legacy)) return claim(legacy);

    // Real collision — hash the resolved path. Lowercase hex survives the
    // `paramLower` lookup in resolveRepoFromCache.
    const digest = createHash('sha256').update(resolved).digest('hex');
    for (let len = REPO_ID_HASH_LENGTH; len <= digest.length; len++) {
      const candidate = `${base}-${digest.slice(0, len)}`;
      if (free(candidate)) return claim(candidate);
    }

    // Two distinct resolved paths sharing a full SHA-256 digest is a hash
    // break, not a runtime condition — fail loudly rather than silently
    // overwrite a different repo's handle (#2054 invariant).
    throw new Error(
      `GitNexus internal: unable to assign a unique repo id for "${name}" at ${repoPath}`,
    );
  }

  // ─── Repo Resolution ─────────────────────────────────────────────

  /**
   * Resolve which repo to use.
   * - If repoParam is given, match by name or path
   * - If only 1 repo, use it
   * - If 0 or multiple without param, throw with helpful message
   *
   * On a miss, re-reads the registry once in case a new repo was indexed
   * while the MCP server was running.
   */
  async resolveRepo(repoParam?: string, branch?: string): Promise<RepoHandle> {
    let refreshedAfterAmbiguity = false;
    let result: RepoHandle | null;
    try {
      result = this.resolveRepoFromCache(repoParam);
    } catch (err) {
      if (!(err instanceof RegistryAmbiguousTargetError)) throw err;
      // Stale in-memory duplicate siblings can linger after unregister; refresh
      // once before re-throwing so a resolved registry can disambiguate (#1658).
      await this.refreshRepos();
      refreshedAfterAmbiguity = true;
      result = this.resolveRepoFromCache(repoParam);
    }

    if (result) {
      // Issue: silent graph drift across sibling clones.
      // If the caller's cwd lives in a *different* on-disk clone of
      // the same repo (matched by `remoteUrl`), warn once per
      // (repo, cwd) pair on stderr. We do not fail or refuse to
      // serve — the index is still the best answer we have — but
      // the operator/agent has to know the answer may be stale.
      this.maybeWarnSiblingDrift(result).catch(() => {
        /* best-effort; never throw from resolveRepo */
      });
      return this.applyBranchScope(result, branch);
    }

    // Miss — refresh registry and try once more (skip if already refreshed above)
    if (!refreshedAfterAmbiguity) {
      await this.refreshRepos();
    }
    const retried = this.resolveRepoFromCache(repoParam);
    if (retried) {
      this.maybeWarnSiblingDrift(retried).catch(() => {});
      return this.applyBranchScope(retried, branch);
    }

    // Still no match — throw with helpful message
    if (this.repos.size === 0) {
      throw new Error('No indexed repositories. Run: gitnexus analyze');
    }

    // Build a disambiguated "Available: …" list (#829). When two handles
    // share a name, annotate each colliding label with its path so the
    // caller can actually pick the right one. Single-name entries render
    // identically to pre-#829 output.
    const nameCounts = new Map<string, number>();
    for (const h of this.repos.values()) {
      const key = h.name.toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    const labels = [...this.repos.values()].map((h) =>
      (nameCounts.get(h.name.toLowerCase()) ?? 0) > 1 ? `${h.name} (${h.repoPath})` : h.name,
    );

    if (repoParam) {
      throw new Error(`Repository "${repoParam}" not found. Available: ${labels.join(', ')}`);
    }
    throw new Error(
      `Multiple repositories indexed. Specify which one with the "repo" parameter. Available: ${labels.join(', ')}`,
    );
  }

  /**
   * Re-point a resolved repo handle at a specific branch index (#2106).
   *
   * - No `branch` (default) → the flat workspace handle, unchanged (backward
   *   compatible: every existing caller passes no branch).
   * - `branch` equal to the flat slot's **on-disk** recorded branch → the
   *   flat handle. The disk meta is read before any cached state is trusted
   *   (#2364 review F1): the flat slot follows the checked-out working tree
   *   (#2354), so a plain analyze after a branch switch restamps the meta
   *   without any repo-resolution miss that would refresh a long-lived
   *   server's cached handle — the cached label can otherwise serve another
   *   branch's content under the old name (the pool staleness reinit
   *   hot-swaps content without updating `handle.branch`).
   * - `branch` matching an indexed pinned branch → a handle whose
   *   `lbugPath` points at `branches/<slug>/lbug`; the connection pool keys by
   *   `lbugPath`, so this is the only change needed to scope every tool. The
   *   sub-index lbug must actually exist on disk — `adoptFlatBranchLabel`
   *   deletes the whole dir when the flat slot takes ownership, and a stale
   *   cached summary must not route to the deleted path.
   * - Cached `handle.branch` is trusted only when there is no readable flat
   *   meta to contradict it (legacy shapes, #2106 R4).
   * - Any miss → a clear error (never a silently-empty result against the
   *   wrong DB), after exactly one `refreshRepos()` so newly-pinned branches
   *   and restamped labels the cached handle predates resolve on the next
   *   call.
   */
  private async applyBranchScope(handle: RepoHandle, branch?: string): Promise<RepoHandle> {
    if (!branch) return handle;
    // At most one cache refresh per resolution: enough for the NEXT call to
    // see fresh handles, without paying two registry re-scans when several
    // stale arms fire in one degraded resolution.
    let refreshed = false;
    const refreshOnce = async (): Promise<void> => {
      if (refreshed) return;
      refreshed = true;
      await this.refreshRepos().catch(() => {});
    };
    // One small JSON read per scoped call; mid-run meta writes preserve the
    // old label until the end-of-run atomic stamp (run-analyze dirty stamps
    // spread the existing meta), so this read never runs ahead of the DB.
    const flatMeta = await loadMeta(path.dirname(handle.lbugPath));
    if (flatMeta?.branch && flatMeta.branch === branch) {
      // The disk meta decides routing, so it also supplies the metadata —
      // the cached handle's label/commit/stats can predate the restamp.
      return {
        ...handle,
        branch: flatMeta.branch,
        indexedAt: flatMeta.indexedAt ?? handle.indexedAt,
        lastCommit: flatMeta.lastCommit ?? handle.lastCommit,
        stats: flatMeta.stats ?? handle.stats,
      };
    }

    // A registry entry claiming `branch` both as the flat label AND as a
    // pinned summary is an adopt-degraded state (rm kept the summary while
    // the label restamped) — never serve the possibly stale-vintage pin for
    // a label the flat slot claims; fall through to the honest error.
    const summary =
      handle.branch !== branch ? handle.branches?.find((b) => b.branch === branch) : undefined;
    if (summary) {
      const { lbugPath } = getStoragePaths(handle.repoPath, branch);
      // The lbug is the artifact the pool opens, so its presence is the
      // serviceability truth — a half-deleted dir can outlive its meta.json
      // while the lbug is gone, and vice versa (#2364 review F1 arm ii).
      // Only provably-absent errno counts as missing: a transient EACCES/EIO
      // on a healthy pinned sub-index must serve the handle (the pool open
      // surfaces the real error) rather than a false "not indexed".
      const probeCode = await fs.access(lbugPath).then(
        () => null,
        (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? 'UNKNOWN',
      );
      const subIndexMissing = probeCode === 'ENOENT' || probeCode === 'ENOTDIR';
      if (!subIndexMissing) {
        return {
          ...handle,
          lbugPath,
          indexedAt: summary.indexedAt,
          lastCommit: summary.lastCommit,
          stats: summary.stats,
        };
      }
      // Stale summary (sub-index adopted/deleted): refresh so later calls see
      // fresh handles, then fall through — the flat meta above is the truth.
      await refreshOnce();
    }

    if (handle.branch && handle.branch === branch) {
      // No readable flat meta (missing/corrupt — loadMeta → null): keep the
      // pre-#2354 trust in the cached label (#2106 R4 legacy shapes). A
      // readable meta that names another branch means the label is stale.
      if (!flatMeta?.branch) return handle;
    }

    // Every miss refreshes once before erroring: newly-pinned branches and
    // restamped labels the cached handle predates become resolvable on the
    // caller's next attempt (the cache otherwise only refreshes on repo-
    // resolution misses and list_repos).
    await refreshOnce();

    // The flat slot's label comes from the authoritative meta when readable —
    // never echo a cached label the meta just contradicted (a "not indexed:
    // main / indexed: main" self-contradiction). Cached summaries may still
    // lag; they are a hint, not a promise.
    const flatLabel = flatMeta?.branch ?? handle.branch;
    const indexed = [flatLabel, ...(handle.branches?.map((b) => b.branch) ?? [])].filter(
      (b) => Boolean(b) && b !== branch,
    );
    const available = indexed.length > 0 ? indexed.join(', ') : '(workspace only)';
    // Post-#2354 a bare `analyze --branch <X>` refuses to run unless X is
    // checked out, so the guidance must lead with the checkout (#2364 F6).
    throw new Error(
      `Branch "${branch}" is not indexed for "${handle.name}". ` +
        `Indexed branches: ${available}. The workspace index follows the ` +
        `checked-out branch — check out "${branch}" and re-run: gitnexus analyze ` +
        `(add --branch ${branch} while it is checked out to pin a separate sub-index).`,
    );
  }

  /**
   * Try to resolve a repo from the in-memory cache. Returns null on miss.
   * Throws {@link RegistryAmbiguousTargetError} when `repoParam` matches
   * multiple handles by name and cwd cannot disambiguate (#1658).
   */
  private resolveRepoFromCache(repoParam?: string): RepoHandle | null {
    if (this.repos.size === 0) return null;

    if (repoParam) {
      const paramLower = repoParam.toLowerCase();
      const looksLikePath =
        path.isAbsolute(repoParam) || repoParam.includes(path.sep) || repoParam.includes('/');

      const resolvePathMatch = (): RepoHandle | undefined => {
        const canonicalTarget = canonicalizePath(repoParam);
        return [...this.repos.values()].find((handle) => {
          const stored = canonicalizePath(handle.repoPath);
          return process.platform === 'win32'
            ? stored.toLowerCase() === canonicalTarget.toLowerCase()
            : stored === canonicalTarget;
        });
      };

      // Path-like params first (absolute or contains separators) — aligns with
      // resolveRegistryEntry (#829). Bare aliases such as ".tmp-repro-mini" must
      // not be resolved via path.resolve(cwd) before duplicate-name handling.
      if (looksLikePath) {
        const pathMatch = resolvePathMatch();
        if (pathMatch) return pathMatch;
      }

      // Exact name before id — the first duplicate sibling keeps id === name
      // (e.g. id "shared"), so a name lookup must not be captured by the id tier.
      const nameMatches = [...this.repos.values()].filter(
        (handle) => handle.name.toLowerCase() === paramLower,
      );
      if (nameMatches.length === 1) return nameMatches[0];
      if (nameMatches.length > 1) {
        const cwdPick = this.pickRepoHandleForCwd(nameMatches);
        if (cwdPick) return cwdPick;
        throw new RegistryAmbiguousTargetError(
          repoParam,
          nameMatches.map((h) => this.handleToRegistryEntry(h)),
        );
      }

      // Stable hashed id (e.g. "shared-abc123") from repoId() collision suffix
      if (this.repos.has(paramLower)) return this.repos.get(paramLower)!;

      // Bare name resolved as a cwd-relative path (e.g. "myrepo" against process.cwd()),
      // after name/id tiers. Path-like strings with separators were handled at the top.
      if (!looksLikePath) {
        const pathMatch = resolvePathMatch();
        if (pathMatch) return pathMatch;
      }

      // Partial name — only when unambiguous
      const partialMatches = [...this.repos.values()].filter((handle) =>
        handle.name.toLowerCase().includes(paramLower),
      );
      if (partialMatches.length === 1) return partialMatches[0];

      return null;
    }

    if (this.repos.size === 1) {
      return this.repos.values().next().value!;
    }

    return null; // Multiple repos, no param — ambiguous
  }

  /**
   * Prefer the indexed repo whose path matches the git root of process.cwd().
   *
   * In MCP stdio server mode, `process.cwd()` is the server's launch directory,
   * not the agent client's cwd. If the server was started from an unrelated
   * directory, `getGitRoot` returns null and duplicate-name resolution throws
   * {@link RegistryAmbiguousTargetError} — callers should pass an absolute path.
   */
  private pickRepoHandleForCwd(candidates: RepoHandle[]): RepoHandle | null {
    const cwdRoot = getGitRoot(process.cwd());
    if (!cwdRoot) return null;
    const canonicalCwd = canonicalizePath(cwdRoot);
    const cwdMatches = candidates.filter((handle) => {
      const stored = canonicalizePath(handle.repoPath);
      return process.platform === 'win32'
        ? stored.toLowerCase() === canonicalCwd.toLowerCase()
        : stored === canonicalCwd;
    });
    return cwdMatches.length === 1 ? cwdMatches[0] : null;
  }

  private handleToRegistryEntry(handle: RepoHandle): RegistryEntry {
    return {
      name: handle.name,
      path: handle.repoPath,
      storagePath: handle.storagePath,
      indexedAt: handle.indexedAt,
      lastCommit: handle.lastCommit,
      stats: handle.stats,
      remoteUrl: handle.remoteUrl,
    };
  }

  // ─── Lazy LadybugDB Init ────────────────────────────────────────────

  /**
   * Ensure the LadybugDB pool is open for the *resolved* repo.
   *
   * Takes the `RepoHandle` the caller resolved — NOT a bare id — and keys the
   * pool (and the init/staleness/reinit maps) by the immutable `lbugPath`. Two
   * things matter for multi-clone correctness: (1) the handle is the one the
   * caller resolved, so a concurrent `refreshRepos` can't substitute a different
   * clone; (2) the pool key is the database path, so distinct clones never share
   * a pool entry even when their name-derived id transiently collides (#2067).
   */
  private async ensureInitialized(repo: RepoHandle): Promise<void> {
    const poolKey = repo.lbugPath;
    // If a reinit is already in progress for this repo, wait for it
    const pending = this.reinitPromises.get(poolKey);
    if (pending) return pending;

    // Check if the index was rebuilt since we opened the connection (#297).
    // Throttle staleness checks to at most once per 5 seconds per repo to
    // avoid an fs.readFile round-trip on every tool invocation.
    if (this.initializedRepos.has(poolKey) && isLbugReady(poolKey)) {
      const now = Date.now();
      const lastCheck = this.lastStalenessCheck.get(poolKey) ?? 0;
      if (now - lastCheck < 5000) return; // Checked recently — skip

      this.lastStalenessCheck.set(poolKey, now);
      try {
        // Read the metadata that sits next to THIS handle's lbug. For the
        // flat/primary handle this is `<storagePath>/gitnexus.json`; for a
        // branch handle it is `<storagePath>/branches/<slug>/gitnexus.json`.
        // loadMeta falls back to legacy meta.json during migration.
        // Reading the flat meta for a branch handle would compare the branch
        // index's indexedAt against the primary's and thrash the pool (#2106).
        const meta = await loadMeta(path.dirname(repo.lbugPath));
        if (!meta) return;
        // Compare against the last indexedAt OBSERVED for this pool (keyed by
        // lbugPath), not the handle's — branch handles are fresh spreads so a
        // handle mutation would not persist and would reinit on every check.
        const observed = this.lastObservedIndexedAt.get(poolKey) ?? repo.indexedAt;
        if (meta.indexedAt && meta.indexedAt !== observed) {
          // Index was rebuilt — close stale connection and re-init.
          // Wrap in reinitPromises to prevent TOCTOU race where concurrent
          // callers both detect staleness and double-close the pool.
          const reinit = (async () => {
            try {
              await closeLbug(poolKey);
              this.initializedRepos.delete(poolKey);
              this.lastObservedIndexedAt.set(poolKey, meta.indexedAt);
              await initLbug(poolKey, repo.lbugPath);
              this.initializedRepos.add(poolKey);
            } finally {
              this.reinitPromises.delete(poolKey);
            }
          })();
          this.reinitPromises.set(poolKey, reinit);
          return reinit;
        } else {
          return; // Pool is current
        }
      } catch {
        return; // Can't read meta — assume pool is fine
      }
    }

    try {
      await initLbug(poolKey, repo.lbugPath);
      this.initializedRepos.add(poolKey);
      this.lastObservedIndexedAt.set(poolKey, repo.indexedAt);
    } catch (err: any) {
      // If lock error, mark as not initialized so next call retries
      this.initializedRepos.delete(poolKey);
      throw err;
    }
  }

  // ─── Public Getters ──────────────────────────────────────────────

  /**
   * Get context for a specific repo (or the single repo if only one).
   */
  getContext(repoId?: string): CodebaseContext | null {
    if (repoId && this.contextCache.has(repoId)) {
      return this.contextCache.get(repoId)!;
    }
    if (this.repos.size === 1) {
      return this.contextCache.values().next().value ?? null;
    }
    return null;
  }

  /**
   * List all registered repos with their metadata.
   * Re-reads the global registry so newly indexed repos are discovered
   * without restarting the MCP server.
   *
   * Each entry includes:
   *   - `staleness`: if the indexed clone's own HEAD has moved past
   *     the recorded `lastCommit` (option D in the issue's fix list).
   *   - `siblings`: other registered entries sharing the same
   *     `remoteUrl` (option B's payoff: callers can see at a glance
   *     that another clone of the same logical repo is registered).
   *   - `remoteUrl`: the canonical origin URL recorded at index time.
   */
  async listRepos(): Promise<RepoListing[]> {
    await this.refreshRepos();
    const handles = [...this.repos.values()];

    // Pre-group registered handles by `remoteUrl` so the sibling
    // lookup is O(1) per handle. We reuse the in-memory `this.repos`
    // (already populated by `refreshRepos`) instead of doing a fresh
    // `readRegistry()` per entry — that would be N file reads for N
    // registered repos.
    const isWin = process.platform === 'win32';
    const norm = (p: string) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
    const byRemote = new Map<string, RepoHandle[]>();
    for (const h of handles) {
      if (!h.remoteUrl) continue;
      const list = byRemote.get(h.remoteUrl) ?? [];
      list.push(h);
      byRemote.set(h.remoteUrl, list);
    }

    // Check staleness for all repos in parallel instead of sequentially.
    // Each check spawns an async `git rev-list` — with 200 repos the sync
    // variant took ~50 s; parallel async brings it under a second (#1363).
    const stalenessResults = await Promise.all(
      handles.map((h) => checkStalenessAsync(h.repoPath, h.lastCommit)),
    );

    return handles.map((h, i) => {
      const stale = stalenessResults[i];
      const selfNorm = norm(h.repoPath);
      const siblings = h.remoteUrl
        ? (byRemote.get(h.remoteUrl) ?? []).filter((e) => norm(e.repoPath) !== selfNorm)
        : [];
      return {
        name: h.name,
        path: h.repoPath,
        indexedAt: h.indexedAt,
        lastCommit: h.lastCommit,
        remoteUrl: h.remoteUrl,
        stats: h.stats,
        staleness: stale.isStale
          ? { commitsBehind: stale.commitsBehind, hint: stale.hint }
          : undefined,
        siblings:
          siblings.length > 0
            ? siblings.map((s) => ({
                name: s.name,
                path: s.repoPath,
                lastCommit: s.lastCommit,
              }))
            : undefined,
        branch: h.branch,
        branches:
          h.branches && h.branches.length > 0
            ? h.branches.map((b) => ({
                branch: b.branch,
                indexedAt: b.indexedAt,
                lastCommit: b.lastCommit,
              }))
            : undefined,
      };
    });
  }

  /**
   * Paginated view over {@link listRepos} for the `list_repos` MCP tool (#2119).
   *
   * `listRepos()` itself still returns the FULL array — its resource and CLI
   * consumers (`gitnexus://repos`, `gitnexus://setup`, startup logs) need every
   * entry, so pagination lives ONLY here, on the tool surface, to keep the
   * response under MCP/LLM token-truncation limits.
   *
   * Determinism: a single registry snapshot is taken per call, then sorted by
   * lower-cased name with the repository path as a tie-breaker. Sibling clones
   * share a name but never a path (#2054), so `(name, path)` is a total order —
   * paging never skips or duplicates an entry while the registry is unchanged.
   * Codepoint comparison (not `localeCompare`) keeps page boundaries stable
   * across machines/locales, matching the existing `refreshRepos` ordering.
   */
  async listReposPage(params?: { limit?: unknown; offset?: unknown } | null): Promise<{
    repositories: RepoListing[];
    pagination: ListReposPagination;
  }> {
    const { limit, offset } = parseListReposPagination(params, {
      defaultLimit: LIST_REPOS_DEFAULT_LIMIT,
      maxLimit: LIST_REPOS_MAX_LIMIT,
    });

    // One consistent snapshot per call (listRepos refreshes the registry once),
    // sorted into a stable total order before slicing.
    const all = await this.listRepos();
    all.sort((a, b) => {
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      if (an !== bn) return an < bn ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });

    const total = all.length;
    const repositories = all.slice(offset, offset + limit);
    const returned = repositories.length;
    const hasMore = offset + returned < total;

    return {
      repositories,
      pagination: {
        total,
        limit,
        offset,
        returned,
        hasMore,
        ...(hasMore && { nextOffset: offset + returned }),
      },
    };
  }

  /**
   * Best-effort sibling-clone drift warning.
   *
   * When the resolved index has a `remoteUrl` recorded and the caller's
   * `process.cwd()` is inside a *different* clone of the same repo, emit
   * one stderr line per (repo, cwd) pair so the operator knows the
   * graph may be stale relative to what's actually on disk under their
   * cwd. Silent on path matches and on repos without a remote URL.
   *
   * Limitation: in MCP stdio server mode `process.cwd()` is the
   * server's CWD at start time, *not* the agent client's CWD. The
   * warning therefore only fires when the MCP server itself was
   * launched from inside a sibling clone (typical for `npx gitnexus
   * serve` from a polecat workspace). Surfacing the client's CWD
   * would require a per-tool-call `cwd` parameter — out of scope for
   * the current MCP contract.
   *
   * Pure side-effect (stderr); never affects the returned handle.
   * After the first computation for a given (repo, cwd) pair the
   * result is cached so subsequent `resolveRepo()` calls don't
   * re-shell-out to git.
   */
  private async maybeWarnSiblingDrift(handle: RepoHandle): Promise<void> {
    if (!handle.remoteUrl) return;
    let cwd: string;
    try {
      cwd = process.cwd();
    } catch {
      return;
    }
    // Early-exit cache: keyed on (repo, cwd) BEFORE any git shellout.
    // After the first call for a given cwd, this short-circuits the
    // up-to-four `execSync`/`execFileSync` calls inside `checkCwdMatch`
    // — important for MCP-server mode where `process.cwd()` is constant
    // and `resolveRepo` runs on every tool call.
    const cacheKey = `${handle.id}|${cwd}`;
    if (this.warnedSiblingDrift.has(cacheKey)) return;

    const match = await checkCwdMatch(cwd);
    if (
      match.match !== 'sibling-by-remote' ||
      !match.entry ||
      !match.cwdGitRoot ||
      match.entry.path !== handle.repoPath ||
      !match.hint
    ) {
      // Cache "nothing to warn about" outcomes too — `checkCwdMatch`
      // is deterministic for a fixed (registry, cwd) pair, so re-running
      // it yields nothing new.
      this.warnedSiblingDrift.add(cacheKey);
      return;
    }

    this.warnedSiblingDrift.add(cacheKey);
    logger.error(`GitNexus: ${match.hint}`);
  }

  // ─── Tool Dispatch ───────────────────────────────────────────────

  async callTool(method: string, params: any): Promise<any> {
    if (method === 'list_repos') {
      // Paginated tool surface (#2119). `listRepos()` is unchanged for internal
      // callers; the tool wraps it in { repositories, pagination } and forwards
      // the limit/offset args that this dispatch previously discarded.
      return this.listReposPage(params);
    }

    if (method.startsWith('group_')) {
      return this.handleGroupTool(method, params || {});
    }

    const normalized = normalizeToolParams(method, params);
    if ('error' in normalized) return { error: normalized.error };
    const p = normalized.params;

    // #2175: Claude Code drops a tool-call argument named exactly "query", so the
    // query/cypher tools advertise "search_query"/"statement" while still accepting the
    // legacy "query" key for backward compat. The alias is resolved with `?? ` (new name
    // wins) at every consumer site rather than by mutating params here, so precedence is
    // uniform and there is no hidden mutation: query()/cypher() read it directly, the
    // legacy "search" alias routes through query(), and the cross-repo group-forward
    // resolves it self-contained in callToolAtGroupRepo. This is permanent compatibility
    // — third-party MCP clients may legitimately send "query", so the alias is not slated
    // for removal even if Claude Code's argument handling later changes.
    if (
      (method === 'impact' || method === 'query' || method === 'context' || method === 'trace') &&
      typeof p.repo === 'string' &&
      p.repo.startsWith('@')
    ) {
      return this.callToolAtGroupRepo(method, p);
    }

    // Resolve repo from optional param (re-reads registry on miss). An optional
    // `branch` param scopes the resolved handle to that branch's index (#2106).
    const repo = await this.resolveRepo(
      p.repo as string | undefined,
      p.branch as string | undefined,
    );

    switch (method) {
      case 'query':
        return this.query(repo, p);
      case 'cypher': {
        const raw = await this.cypher(repo, p);
        return this.formatCypherAsMarkdown(raw);
      }
      case 'context':
        return this.context(repo, p);
      case 'explain':
        return this.explain(repo, p);
      case 'pdg_query':
        return this.pdgQuery(repo, p);
      case 'impact':
        return this.impact(repo, p as unknown as ImpactParams);
      case 'detect_changes':
        return this.detectChanges(repo, p);
      case 'check':
        return this.check(repo, p);
      case 'rename':
        return this.rename(repo, p as unknown as Parameters<LocalBackend['rename']>[1]);
      // Legacy aliases for backwards compatibility
      case 'search':
        return this.query(repo, p);
      case 'explore':
        return this.context(repo, {
          name: typeof p.name === 'string' ? p.name : undefined,
          ...p,
        });
      case 'overview':
        return this.overview(repo, p);
      case 'route_map':
        return this.routeMap(repo, p);
      case 'shape_check':
        return this.shapeCheck(repo, p);
      case 'tool_map':
        return this.toolMap(repo, p);
      case 'api_impact':
        return this.apiImpact(repo, p);
      case 'trace':
        return this.trace(repo, p);
      default:
        throw new Error(`Unknown tool: ${method}`);
    }
  }

  // ─── Tool Implementations ────────────────────────────────────────

  /** Check repository graph invariants that are suitable for CI gating. */
  private async check(repo: RepoHandle, params?: { cycles?: boolean }): Promise<any> {
    if (params?.cycles === false) {
      return { error: 'No checks selected. Set "cycles" to true.' };
    }
    await this.ensureInitialized(repo);
    const rowLimit = 100_001;
    const rows = await executeParameterized(
      repo.lbugPath,
      `MATCH (source:File)-[r:CodeRelation]->(target:File)
       WHERE r.type = 'IMPORTS'
         AND (r.reason IS NULL OR (
           r.reason <> 'swift-scope: implicit module visibility'
           AND r.reason <> 'markdown-link'
         ))
       RETURN source.filePath AS source, target.filePath AS target
       LIMIT ${rowLimit}`,
      {},
    );
    if (rows.length === rowLimit) {
      return {
        error: `Import graph exceeds the ${rowLimit - 1} edge safety limit.`,
        truncated: true,
      };
    }
    const cycles = findImportCycles(
      rows.map((row: any) => ({
        source: String(row.source ?? row[0] ?? ''),
        target: String(row.target ?? row[1] ?? ''),
      })),
    );
    return {
      status: cycles.length === 0 ? 'clean' : 'cycles_found',
      cycleCount: cycles.length,
      cycles: cycles.map((files) => ({ files })),
    };
  }

  /**
   * Query tool — process-grouped search.
   *
   * 1. Hybrid search (BM25 + semantic) to find matching symbols
   * 2. Trace each match to its process(es) via STEP_IN_PROCESS
   * 3. Group by process, rank by aggregate relevance + internal cluster cohesion
   * 4. Return: { processes, process_symbols, definitions }
   */
  private async query(
    repo: RepoHandle,
    params: {
      query?: string;
      search_query?: string;
      task_context?: string;
      goal?: string;
      limit?: number;
      max_symbols?: number;
      include_content?: boolean;
    },
  ): Promise<any> {
    // #2175: each consumer resolves the search_query/query alias itself (there is no
    // chokepoint mutation in callTool). This also serves the GroupService port, which
    // reaches query() carrying only the legacy `query` key.
    const rawQuery = resolveAliasString(params.search_query, params.query);
    if (!rawQuery?.trim()) {
      return { error: 'search_query (or legacy query) parameter is required and cannot be empty.' };
    }

    await this.ensureInitialized(repo);

    const processLimit = params.limit || 5;
    const maxSymbolsPerProcess = params.max_symbols || 10;
    const includeContent = params.include_content ?? false;
    const searchQuery = rawQuery.trim();

    // Per-phase timing instrumentation (#553). Records wall time for each
    // observable sub-step of the search pipeline so production latency can
    // be aggregated offline for Pareto analysis and bottleneck detection.
    // Overhead is <0.1 ms per phase; the timer is passive and never alters
    // query behaviour.
    const timer = new PhaseTimer();
    const wallStart = performance.now();

    // Step 1: Run hybrid search to get matching symbols. BM25 and vector
    // search run concurrently via Promise.all — use `timer.time()` for
    // each so both get independent wall-time records without fighting
    // over a single `current` phase slot.
    const searchLimit = processLimit * maxSymbolsPerProcess; // fetch enough raw results
    const [bm25SearchResult, semanticResults] = await Promise.all([
      timer.time('bm25', this.bm25Search(repo, searchQuery, searchLimit)),
      timer.time('vector', this.semanticSearch(repo, searchQuery, searchLimit)),
    ]);

    // Guard against undefined results (#1489) — when FTS is entirely
    // unavailable the search helper may return an unexpected shape.
    const bm25Results = bm25SearchResult?.results ?? [];
    const ftsUsed = bm25SearchResult?.ftsUsed ?? false;

    // Merge via reciprocal rank fusion
    timer.start('merge');
    const scoreMap = new Map<string, { score: number; data: any }>();

    for (let i = 0; i < bm25Results.length; i++) {
      const result = bm25Results[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (60 + i);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }

    const safeSemanticResults = semanticResults ?? [];
    for (let i = 0; i < safeSemanticResults.length; i++) {
      const result = safeSemanticResults[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (60 + i);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }

    const merged = Array.from(scoreMap.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, searchLimit);
    timer.stop(); // merge

    // Step 2: For each match with a nodeId, trace to process(es)
    timer.start('symbol_lookup');
    const processMap = new Map<
      string,
      {
        id: string;
        label: string;
        heuristicLabel: string;
        processType: string;
        stepCount: number;
        totalScore: number;
        cohesionBoost: number;
        symbols: any[];
      }
    >();
    const definitions: any[] = []; // standalone symbols not in any process

    // Batch-fetch process participation, cohesion, and (optionally) content for
    // ALL matched symbols in 2-3 graph queries instead of 2-3 *per symbol*. The
    // previous per-symbol loop issued up to 3N sequential pool round-trips
    // (searchLimit symbols × {STEP_IN_PROCESS, MEMBER_OF, content}); on a warm
    // repo the IPC + query-setup overhead of those round-trips dominated query
    // latency. Collapsing to `WHERE n.id IN $nodeIds` preserves identical output
    // (the aggregation loop below is unchanged) while cutting the round-trips.
    // Array params bind through the pool exactly as bm25Search's
    // `WHERE n.id IN $nodeIds` already does. (Ported from gitnexus-enterprise
    // PR #222 — N+1 → 2-3 batched queries.)
    const nodeIds = merged.map(([, m]) => m.data?.nodeId).filter((id): id is string => !!id);

    const processRowsByNode = new Map<string, any[]>();
    const cohesionByNode = new Map<string, { cohesion: number; module?: string }>();
    const contentByNode = new Map<string, string>();
    // Set when a batched enrichment query throws a REAL failure (timeout, lock,
    // native fault) — NOT the benign "no Process/Community table" case, which is
    // a normal config (a repo analyzed without processes/communities) and must
    // not raise a `partial` flag callers would learn to ignore. See
    // isBenignMissingTableError + the response build below.
    let enrichmentDegraded = false;

    // Chunk the IN-list like the impact path (CHUNK_SIZE=100) so a large result
    // set never builds an unbounded `IN` parameter. Default batch is
    // processLimit*maxSymbolsPerProcess (≤ one chunk), but chunk for robustness.
    const QUERY_CHUNK_SIZE = 100;
    for (let i = 0; i < nodeIds.length; i += QUERY_CHUNK_SIZE) {
      const ids = nodeIds.slice(i, i + QUERY_CHUNK_SIZE);

      // Processes each symbol participates in. `n.id AS nodeId` is prepended as
      // column 0 so rows from many symbols can be re-associated to their symbol.
      try {
        const rows = await executeParameterized(
          repo.lbugPath,
          `
          MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE n.id IN $nodeIds
          RETURN n.id AS nodeId, p.id AS pid, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `,
          { nodeIds: ids },
        );
        for (const row of rows) {
          const nid = row.nodeId ?? row[0];
          let list = processRowsByNode.get(nid);
          if (!list) processRowsByNode.set(nid, (list = []));
          list.push(row);
        }
      } catch (e) {
        logQueryError('query:process-lookup', e);
        if (!isBenignMissingTableError(e)) enrichmentDegraded = true;
      }

      // Cluster membership + cohesion. Keep the FIRST community row per node to
      // mirror the prior per-symbol `LIMIT 1` (each symbol keeps ITS community,
      // not one community for the whole batch).
      try {
        const rows = await executeParameterized(
          repo.lbugPath,
          `
          MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE n.id IN $nodeIds
          RETURN n.id AS nodeId, c.cohesion AS cohesion, c.heuristicLabel AS module
        `,
          { nodeIds: ids },
        );
        for (const row of rows) {
          const nid = row.nodeId ?? row[0];
          if (!cohesionByNode.has(nid)) {
            cohesionByNode.set(nid, {
              cohesion: (row.cohesion ?? row[1]) || 0,
              module: row.module ?? row[2],
            });
          }
        }
      } catch (e) {
        logQueryError('query:cluster-info', e);
        if (!isBenignMissingTableError(e)) enrichmentDegraded = true;
      }

      // Optionally fetch content for every matched symbol.
      if (includeContent) {
        try {
          const rows = await executeParameterized(
            repo.lbugPath,
            `
            MATCH (n)
            WHERE n.id IN $nodeIds
            RETURN n.id AS nodeId, n.content AS content
          `,
            { nodeIds: ids },
          );
          for (const row of rows) {
            const nid = row.nodeId ?? row[0];
            contentByNode.set(nid, row.content ?? row[1]);
          }
        } catch (e) {
          logQueryError('query:content-fetch', e);
          if (!isBenignMissingTableError(e)) enrichmentDegraded = true;
        }
      }
    }

    // Aggregation is unchanged from the per-symbol version — it now reads the
    // pre-fetched maps instead of issuing a query per symbol. Iterating `merged`
    // in the same (sorted) order preserves processMap insertion order, the
    // definitions order, and the item.score association exactly.
    for (const [_, item] of merged) {
      const sym = item.data;
      if (!sym.nodeId) {
        // File-level results go to definitions
        definitions.push({
          name: sym.name,
          type: sym.type || 'File',
          filePath: sym.filePath,
        });
        continue;
      }

      const processRows = processRowsByNode.get(sym.nodeId) ?? [];
      const coh = cohesionByNode.get(sym.nodeId);
      const cohesion = coh?.cohesion ?? 0;
      const module = coh?.module;
      const content = includeContent ? contentByNode.get(sym.nodeId) : undefined;

      const symbolEntry = {
        id: sym.nodeId,
        name: sym.name,
        type: sym.type,
        filePath: sym.filePath,
        startLine: toDisplayLine(sym.startLine),
        endLine: toDisplayLine(sym.endLine),
        ...(module ? { module } : {}),
        ...(includeContent && content ? { content } : {}),
      };

      if (processRows.length === 0) {
        // Symbol not in any process — goes to definitions
        definitions.push(symbolEntry);
      } else {
        // Add to each process it belongs to
        for (const row of processRows) {
          // Positional fallbacks shift +1 because `n.id AS nodeId` is column 0.
          const pid = row.pid ?? row[1];
          const label = row.label ?? row[2];
          const hLabel = row.heuristicLabel ?? row[3];
          const pType = row.processType ?? row[4];
          const stepCount = row.stepCount ?? row[5];
          const step = row.step ?? row[6];

          if (!processMap.has(pid)) {
            processMap.set(pid, {
              id: pid,
              label,
              heuristicLabel: hLabel,
              processType: pType,
              stepCount,
              totalScore: 0,
              cohesionBoost: 0,
              symbols: [],
            });
          }

          const proc = processMap.get(pid)!;
          proc.totalScore += item.score;
          proc.cohesionBoost = Math.max(proc.cohesionBoost, cohesion);
          proc.symbols.push({
            ...symbolEntry,
            process_id: pid,
            step_index: step,
          });
        }
      }
    }

    timer.stop(); // symbol_lookup

    // Step 3: Rank processes by aggregate score + internal cohesion boost
    timer.start('ranking');
    const rankedProcesses = Array.from(processMap.values())
      .map((p) => ({
        ...p,
        priority: p.totalScore + p.cohesionBoost * 0.1, // cohesion as subtle ranking signal
      }))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, processLimit);
    timer.stop(); // ranking

    // Step 4: Build response
    timer.start('formatting');
    const processes = rankedProcesses.map((p) => ({
      id: p.id,
      summary: p.heuristicLabel || p.label,
      priority: Math.round(p.priority * 1000) / 1000,
      symbol_count: p.symbols.length,
      process_type: p.processType,
      step_count: p.stepCount,
    }));

    const processSymbols = rankedProcesses.flatMap((p) =>
      p.symbols.slice(0, maxSymbolsPerProcess).map((s) => ({
        ...s,
        // remove internal fields
      })),
    );

    // Deduplicate process_symbols by id
    const seen = new Set<string>();
    const dedupedSymbols = processSymbols.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    timer.stop(); // formatting

    // End-to-end wall time — deliberately a separate mark so callers can
    // compare sum(phases) vs wall to see how much Promise.all concurrency
    // saved. Must come before summary() so it's included.
    timer.mark('wall', performance.now() - wallStart);
    const timing = timer.summary();
    logQueryTiming(searchQuery, timing);

    // Compose a single `warning` from all degraded conditions (FTS-missing
    // and/or a real enrichment failure) so neither overwrites the other, and
    // flag `partial` when enrichment was lost. Both are omitted on the clean
    // path, leaving the success-path response shape byte-identical.
    const warnings: string[] = [];
    if (!ftsUsed) {
      warnings.push(ftsDegradedWarning());
    }
    // #2331: a CJK query against a server process resolving
    // GITNEXUS_FTS_CJK_SEGMENTATION to 'none' silently misses sub-phrase
    // matches with no other signal — this is the only place an agent driving
    // GitNexus through the query tool can learn the capability exists.
    try {
      const cjkMode = getSearchFTSCjkSegmentation();
      if (containsSegmentableCjkRun(searchQuery) && cjkMode !== 'bigram') {
        warnings.push(
          'Query contains CJK characters — sub-phrase matches require GITNEXUS_FTS_CJK_SEGMENTATION=bigram set for both `analyze` and this server process, then `gitnexus analyze --force`.',
        );
      } else if (
        cjkMode === 'bigram' &&
        searchQuery.length > MAX_CJK_SEGMENTATION_QUERY_LENGTH &&
        containsSegmentableCjkRun(searchQuery)
      ) {
        // #2339: bigram mode is enabled, but the query exceeds the length
        // cap that guards segmentCjkSpans's per-character allocation cost —
        // applyCjkSegmentationIfEnabled silently skips segmentation above
        // this length, so an over-cap CJK query returns zero results for
        // text that IS indexed and present verbatim, with no other signal.
        warnings.push(
          `Query exceeds the ${MAX_CJK_SEGMENTATION_QUERY_LENGTH}-character CJK segmentation cap — ` +
            'sub-phrase matches are skipped for this query even though GITNEXUS_FTS_CJK_SEGMENTATION=bigram is enabled. Shorten the query to search within the cap.',
        );
      }
    } catch (err) {
      // Best-effort diagnostic only — never fail the query over it.
      logQueryError('query:cjk-warning', err);
    }
    // #2339: the checks above only compare the QUERY's own content against
    // the live process's mode — they can't detect "server mode is 'bigram'
    // but the on-disk index was actually built under 'none'/legacy" (env var
    // changed without a full --force re-analyze, or a plain/--repair-fts
    // analyze ran instead). That mismatch affects every CJK query against
    // this repo, not just one whose own text happens to contain CJK, so it's
    // a separate, unconditional check — not folded into the branches above.
    try {
      const meta = await loadMeta(path.dirname(repo.lbugPath));
      // meta.json is on-disk state inside the analyzed repo, read via a
      // schema-less JSON.parse — not trusted input. Validate before
      // interpolating it into agent-visible tool output (#2339): an
      // unrecognized value is itself evidence of a corrupt/foreign index,
      // reported generically rather than echoed verbatim.
      const persistedMode = meta?.cjkSegmentation;
      if (meta && persistedMode !== undefined && !isSupportedCjkSegmentationMode(persistedMode)) {
        warnings.push(
          "This repo's index metadata has an unrecognized CJK segmentation mode stamp — the index " +
            'may be corrupt or from an incompatible GitNexus version. Run `gitnexus analyze --force` to rebuild it.',
        );
      } else if (
        meta &&
        cjkSegmentationModeMismatch(meta.cjkSegmentation, getSearchFTSCjkSegmentation())
      ) {
        warnings.push(
          `Index was built with CJK segmentation mode '${meta.cjkSegmentation ?? 'none'}', but this ` +
            `server is resolving '${getSearchFTSCjkSegmentation()}' — sub-phrase CJK search results ` +
            'may be incomplete. Set GITNEXUS_FTS_CJK_SEGMENTATION to the same value for both the ' +
            '`analyze` process and this server, then run `gitnexus analyze --force` to rebuild under ' +
            "the agreed mode (do not assume the live server's mode is the one to keep — re-analyzing " +
            'under the wrong mode can strip an already-working bigram-segmented index back to `none`).',
        );
      }
    } catch (err) {
      // loadMeta() itself never throws (it returns null on any read/parse
      // failure) — the actual throw source here is getSearchFTSCjkSegmentation()
      // on an invalid env value, same root cause as the catch above. This is
      // a separate, independently-guarded diagnostic though, so it gets its
      // own log context rather than sharing 'query:cjk-warning'.
      logQueryError('query:cjk-mode-drift', err);
    }
    if (enrichmentDegraded) {
      warnings.push(
        'Symbol enrichment partially failed — some process/cohesion/content data may be missing from these results (see server logs).',
      );
    }

    return {
      processes,
      process_symbols: dedupedSymbols,
      definitions: definitions.slice(0, 20), // cap standalone definitions
      timing,
      ...(warnings.length > 0 && { warning: warnings.join(' ') }),
      ...(enrichmentDegraded && { partial: true }),
    };
  }

  /**
   * BM25 keyword search helper - uses LadybugDB FTS for always-fresh results
   */
  private async bm25Search(
    repo: RepoHandle,
    query: string,
    limit: number,
  ): Promise<{ results: any[]; ftsUsed: boolean }> {
    let searchFTSFromLbug;
    try {
      ({ searchFTSFromLbug } = await import('../../core/search/bm25-index.js'));
    } catch (err: any) {
      // Module import can fail in sandboxed MCP contexts (#1489)
      logger.warn(
        { err: err?.message },
        'GitNexus: bm25-index.js import failed — falling back to semantic-only',
      );
      return { results: [], ftsUsed: false };
    }
    let ftsResponse;
    try {
      ftsResponse = await searchFTSFromLbug(query, limit, repo.lbugPath);
    } catch (err: any) {
      // Swallowed, gracefully-degraded failure: the search falls back to
      // semantic-only (a valid result), and the most common cause is simply an
      // un-indexed FTS extension — a normal configuration, not an operation
      // error. Logged at warn (matching the sibling import-failure fallback
      // above), never error, so it does not raise a false alarm.
      logger.warn(
        { err: err.message },
        'GitNexus: BM25/FTS search failed (FTS indexes may not exist) — falling back to semantic-only',
      );
      return { results: [], ftsUsed: false };
    }

    // Guard against unexpected response shape (#1489) — ftsResponse.results
    // could be undefined when the FTS extension is unavailable in the MCP process.
    const bm25Results = ftsResponse?.results ?? [];
    const ftsUsed = ftsResponse?.ftsAvailable ?? false;

    const results: any[] = [];

    for (const bm25Result of bm25Results) {
      const fullPath = bm25Result.filePath;
      try {
        // Prefer direct nodeId lookup (exact FTS-matched nodes) over filePath fallback.
        // Without this, LIMIT 3 on filePath returns arbitrary symbols rather than
        // the nodes that actually scored highest in the BM25 index.
        const nodeIds = bm25Result.nodeIds?.length ? bm25Result.nodeIds : null;
        const symbols = nodeIds
          ? await executeParameterized(
              repo.lbugPath,
              `
              MATCH (n)
              WHERE n.id IN $nodeIds
              RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
            `,
              { nodeIds },
            )
          : await executeParameterized(
              repo.lbugPath,
              // Same BasicBlock exclusion as detect_changes (#2082 U7): on a
              // --pdg index a function-heavy file has far more BasicBlock rows
              // than symbols, so an unfiltered LIMIT 3 would surface nameless
              // substrate rows and displace the real symbols.
              `
              MATCH (n)
              WHERE n.filePath = $filePath
                AND NOT n.id STARTS WITH 'BasicBlock:'
              RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
              LIMIT 3
            `,
              { filePath: fullPath },
            );

        if (symbols.length > 0) {
          for (const sym of symbols) {
            results.push({
              nodeId: sym.id || sym[0],
              name: sym.name || sym[1],
              type: sym.type || sym[2],
              filePath: sym.filePath || sym[3],
              // Raw 0-based here — `bm25Search` is only called from `query()`,
              // whose aggregation loop applies `toDisplayLine` once (see below).
              // Converting here too would double-shift BM25-matched lines (#2380).
              startLine: sym.startLine ?? sym[4],
              endLine: sym.endLine ?? sym[5],
              bm25Score: bm25Result.score,
            });
          }
        } else {
          const fileName = fullPath.split('/').pop() || fullPath;
          results.push({
            name: fileName,
            type: 'File',
            filePath: bm25Result.filePath,
            bm25Score: bm25Result.score,
          });
        }
      } catch {
        const fileName = fullPath.split('/').pop() || fullPath;
        results.push({
          name: fileName,
          type: 'File',
          filePath: bm25Result.filePath,
          bm25Score: bm25Result.score,
        });
      }
    }

    return { results, ftsUsed };
  }

  /**
   * Semantic vector search helper
   */
  private async semanticSearch(repo: RepoHandle, query: string, limit: number): Promise<any[]> {
    try {
      // Check if embedding table exists before loading the model (avoids heavy model init when embeddings are off)
      const tableCheck = await executeQuery(
        repo.lbugPath,
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN COUNT(*) AS cnt LIMIT 1`,
      );
      if (!tableCheck.length || (tableCheck[0].cnt ?? tableCheck[0][0]) === 0) return [];

      const { embedQuery, getEmbeddingDims } = await import('../core/embedder.js');
      const queryVec = await embedQuery(query);
      const dims = getEmbeddingDims();
      const queryVecStr = `[${queryVec.join(',')}]`;
      const maxDistance = getVectorMaxDistance(DEFAULT_MCP_VECTOR_MAX_DISTANCE);

      let bestChunks = new Map<
        string,
        { distance: number; chunkIndex: number; startLine: number; endLine: number }
      >();
      if (isVectorExtensionSupportedByPlatform()) {
        try {
          bestChunks = await collectBestChunks(limit, async (fetchLimit) => {
            const vectorQuery = `
            CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}',
              CAST(${queryVecStr} AS FLOAT[${dims}]), ${fetchLimit})
            YIELD node AS emb, distance
            WITH emb, distance
            WHERE distance < ${maxDistance}
            RETURN emb.nodeId AS nodeId, emb.chunkIndex AS chunkIndex,
                   emb.startLine AS startLine, emb.endLine AS endLine, distance
            ORDER BY distance
          `;

            const embResults = await executeQuery(repo.lbugPath, vectorQuery);
            return embResults.map((row) => ({
              nodeId: row.nodeId ?? row[0],
              chunkIndex: row.chunkIndex ?? row[1] ?? 0,
              startLine: row.startLine ?? row[2] ?? 0,
              endLine: row.endLine ?? row[3] ?? 0,
              distance: row.distance ?? row[4],
            }));
          });
        } catch {
          bestChunks = new Map();
        }
      } else if (!this.warnedVectorUnsupported) {
        // Rare diagnostic: surface why we fell back to the exact scan path so
        // operators can see at a glance that VECTOR is disabled by platform
        // policy. Emitted once per `LocalBackend` instance lifetime to avoid
        // noisy stderr on hot semantic-search paths (DoD §2.8).
        this.warnedVectorUnsupported = true;
        logger.warn(
          'GitNexus [query:vector]: VECTOR extension not supported on this platform; using exact scan fallback',
        );
      }

      if (bestChunks.size === 0) {
        const embeddingCount = Number(tableCheck[0].cnt ?? tableCheck[0][0] ?? 0);
        const exactLimit = getExactScanLimit();
        if (embeddingCount > exactLimit) return [];

        const rows = await executeQuery(
          repo.lbugPath,
          `
          MATCH (e:${EMBEDDING_TABLE_NAME})
          RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex,
                 e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding
        `,
        );
        const exactRows: ExactEmbeddingRow[] = rows.map((row) => ({
          nodeId: row.nodeId ?? row[0],
          chunkIndex: row.chunkIndex ?? row[1] ?? 0,
          startLine: row.startLine ?? row[2] ?? 0,
          endLine: row.endLine ?? row[3] ?? 0,
          embedding: row.embedding ?? row[4] ?? [],
        }));
        bestChunks = new Map(
          rankExactEmbeddingRows(exactRows, queryVec, limit, maxDistance).map((row) => [
            row.nodeId,
            {
              distance: row.distance,
              chunkIndex: row.chunkIndex,
              startLine: row.startLine,
              endLine: row.endLine,
            },
          ]),
        );
      }

      if (bestChunks.size === 0) return [];

      const results: any[] = [];

      for (const [nodeId, chunk] of Array.from(bestChunks.entries()).slice(0, limit)) {
        const labelEndIdx = nodeId.indexOf(':');
        const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';

        // Validate label against known node types to prevent Cypher injection
        if (!VALID_NODE_LABELS.has(label)) continue;

        try {
          const nodeQuery =
            label === 'File'
              ? `MATCH (n:File {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`
              : `MATCH (n:\`${label}\` {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`;

          const nodeRows = await executeParameterized(repo.lbugPath, nodeQuery, { nodeId });
          if (nodeRows.length > 0) {
            const nodeRow = nodeRows[0];
            results.push({
              nodeId,
              name: nodeRow.name ?? nodeRow[0] ?? '',
              type: label,
              filePath: nodeRow.filePath ?? nodeRow[1] ?? '',
              distance: chunk.distance,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
            });
          }
        } catch {}
      }

      return results;
    } catch (err) {
      // Embeddings disabled is the common, silent case. But a pruned or
      // Node-unloadable optional stack (#2370/#2372) also lands here — surface it
      // once so semantic search doesn't silently degrade to BM25 with no hint
      // (the exact silent-degradation mode #2370 exists to fix). Emitted once per
      // LocalBackend instance to keep stderr quiet on hot paths (like the VECTOR
      // fallback above). All other errors stay silent, as before.
      const message = err instanceof Error ? err.message : '';
      if (
        !this.warnedMissingEmbeddingStack &&
        (isMissingLocalEmbeddingStackMessage(message) ||
          isLocalEmbeddingRuntimeBlockerMessage(message))
      ) {
        this.warnedMissingEmbeddingStack = true;
        logger.warn(`GitNexus [query:vector]: ${message}`);
      }
      return [];
    }
  }

  async executeCypher(
    repoName: string,
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    return this.cypher(repo, { query, params });
  }

  private async cypher(
    repo: RepoHandle,
    // #2175: "statement" is the advertised param; "query" is the legacy alias,
    // still accepted (and the field the internal executeCypher() passes). New wins.
    request: { query?: string; statement?: string; params?: Record<string, unknown> },
  ): Promise<any> {
    await this.ensureInitialized(repo);

    if (!isLbugReady(repo.lbugPath)) {
      return { error: 'LadybugDB not ready. Index may be corrupted.' };
    }
    if (request.params !== undefined && !isValidQueryParams(request.params)) {
      return {
        error: '"params" must be a plain object with scalar values (string/number/boolean/null).',
      };
    }

    const cypherText = resolveAliasString(request.statement, request.query) ?? '';
    if (!cypherText.trim()) {
      // Mirror query()'s friendly required-param error instead of letting an empty
      // string fall through to a raw LadybugDB prepare error (#2175 review).
      return { error: 'statement (or legacy query) parameter is required and cannot be empty.' };
    }

    try {
      const result = await executeParameterized(repo.lbugPath, cypherText, request.params ?? {});
      return result;
    } catch (err: any) {
      const msg = err.message || 'Query failed';
      if (isReadOnlyDbError(err)) {
        return {
          error:
            'Write operations (CREATE, DELETE, SET, MERGE, REMOVE, DROP, ALTER, COPY, DETACH) are not allowed. The knowledge graph is read-only.',
        };
      }
      if (isWalCorruptionError(err)) {
        return {
          error: msg,
          recoverySuggestion: WAL_RECOVERY_SUGGESTION,
        };
      }
      return { error: msg };
    }
  }

  /**
   * Format raw Cypher result rows as a markdown table for LLM readability.
   * Falls back to raw result if rows aren't tabular objects.
   */
  private formatCypherAsMarkdown(result: any): any {
    if (!Array.isArray(result) || result.length === 0) return result;

    const firstRow = result[0];
    if (typeof firstRow !== 'object' || firstRow === null) return result;

    const keys = Object.keys(firstRow);
    if (keys.length === 0) return result;

    const header = '| ' + keys.join(' | ') + ' |';
    const separator = '| ' + keys.map(() => '---').join(' | ') + ' |';
    const dataRows = result.map(
      (row: any) =>
        '| ' +
        keys
          .map((k) => {
            const v = row[k];
            if (v === null || v === undefined) return '';
            if (typeof v === 'object') return JSON.stringify(v);
            // Collapse newlines so a multi-line cell value (e.g. a symbol's
            // `content`) stays on one physical line. Otherwise the rendered row
            // spans multiple lines, which corrupts the table and breaks the
            // CLI's `--limit` line-based slicing (#2310 review).
            return String(v).replace(/\r?\n/g, ' ');
          })
          .join(' | ') +
        ' |',
    );

    return {
      markdown: [header, separator, ...dataRows].join('\n'),
      row_count: result.length,
    };
  }

  /**
   * Aggregate same-named clusters: group by heuristicLabel, sum symbols,
   * weighted-average cohesion, filter out tiny clusters (<5 symbols).
   * Raw communities stay intact in LadybugDB for Cypher queries.
   */
  private aggregateClusters(clusters: any[]): any[] {
    const groups = new Map<
      string,
      { ids: string[]; totalSymbols: number; weightedCohesion: number; largest: any }
    >();

    for (const c of clusters) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      const symbols = c.symbolCount || 0;
      const cohesion = c.cohesion || 0;
      const existing = groups.get(label);

      if (!existing) {
        groups.set(label, {
          ids: [c.id],
          totalSymbols: symbols,
          weightedCohesion: cohesion * symbols,
          largest: c,
        });
      } else {
        existing.ids.push(c.id);
        existing.totalSymbols += symbols;
        existing.weightedCohesion += cohesion * symbols;
        if (symbols > (existing.largest.symbolCount || 0)) {
          existing.largest = c;
        }
      }
    }

    return Array.from(groups.entries())
      .map(([label, g]) => ({
        id: g.largest.id,
        label,
        heuristicLabel: label,
        symbolCount: g.totalSymbols,
        cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
        subCommunities: g.ids.length,
      }))
      .filter((c) => c.symbolCount >= 5)
      .sort((a, b) => b.symbolCount - a.symbolCount);
  }

  private async overview(
    repo: RepoHandle,
    params: { showClusters?: boolean; showProcesses?: boolean; limit?: number },
  ): Promise<any> {
    await this.ensureInitialized(repo);

    const limit = params.limit || 20;
    const result: any = {
      repo: repo.name,
      repoPath: repo.repoPath,
      stats: repo.stats,
      indexedAt: repo.indexedAt,
      lastCommit: repo.lastCommit,
    };

    if (params.showClusters !== false) {
      try {
        // Fetch more raw communities than the display limit so aggregation has enough data
        const rawLimit = Math.max(limit * 5, 200);
        const clusters = await executeQuery(
          repo.lbugPath,
          `
          MATCH (c:Community)
          RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
          ORDER BY c.symbolCount DESC
          LIMIT ${rawLimit}
        `,
        );
        const rawClusters = clusters.map((c: any) => ({
          id: c.id || c[0],
          label: c.label || c[1],
          heuristicLabel: c.heuristicLabel || c[2],
          cohesion: c.cohesion || c[3],
          symbolCount: c.symbolCount || c[4],
        }));
        result.clusters = this.aggregateClusters(rawClusters).slice(0, limit);
      } catch {
        result.clusters = [];
      }
    }

    if (params.showProcesses !== false) {
      try {
        const processes = await executeQuery(
          repo.lbugPath,
          `
          MATCH (p:Process)
          RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
          ORDER BY p.stepCount DESC
          LIMIT ${limit}
        `,
        );
        result.processes = processes.map((p: any) => ({
          id: p.id || p[0],
          label: p.label || p[1],
          heuristicLabel: p.heuristicLabel || p[2],
          processType: p.processType || p[3],
          stepCount: p.stepCount || p[4],
        }));
      } catch {
        result.processes = [];
      }
    }

    return result;
  }

  /**
   * Patch the `type` field on candidates whose `labels(n)[0]` projection
   * came back empty — a known LadybugDB behaviour for several node types.
   *
   * Uses one scoped UNION query across the five priority labels rather
   * than per-candidate round-trips, so cost is a single DB call regardless
   * of how many candidates need enrichment. No-op when every candidate
   * already has a non-empty type.
   *
   * Failures are swallowed: label enrichment is an optimisation for
   * downstream scoring and #480 Class/Interface BFS seeding; if it fails
   * the symbol still resolves, just without the kind-priority bonus.
   */
  private async enrichCandidateLabels(
    repo: RepoHandle,
    candidates: Array<{ id: string; type: string }>,
  ): Promise<void> {
    const ids = candidates.filter((c) => c.type === '' && c.id).map((c) => c.id);
    if (ids.length === 0) return;
    try {
      const rows = await executeParameterized(
        repo.lbugPath,
        `
        MATCH (n:\`Class\`) WHERE n.id IN $ids RETURN n.id AS id, 'Class' AS label
        UNION ALL
        MATCH (n:\`Interface\`) WHERE n.id IN $ids RETURN n.id AS id, 'Interface' AS label
        UNION ALL
        MATCH (n:\`Function\`) WHERE n.id IN $ids RETURN n.id AS id, 'Function' AS label
        UNION ALL
        MATCH (n:\`Method\`) WHERE n.id IN $ids RETURN n.id AS id, 'Method' AS label
        UNION ALL
        MATCH (n:\`Constructor\`) WHERE n.id IN $ids RETURN n.id AS id, 'Constructor' AS label
        `,
        { ids },
      );
      const labelById = new Map<string, string>();
      for (const r of rows as any[]) {
        const id = (r.id ?? r[0]) as string;
        const label = (r.label ?? r[1]) as string;
        if (id && label && !labelById.has(id)) labelById.set(id, label);
      }
      for (const c of candidates) {
        if (c.type === '' && labelById.has(c.id)) c.type = labelById.get(c.id) as string;
      }
    } catch {
      /* best-effort — downstream resolvers still work without the label */
    }
  }

  /**
   * Score a symbol candidate for disambiguation ranking.
   *
   * Deterministic, no DB round-trip:
   *   - base 0.50
   *   - +0.40 when file_path hint matches (substring, case-insensitive)
   *   - +0.20 when kind hint exactly matches the candidate's kind
   *   - when no kind hint, a small priority bonus (Class > Interface >
   *     Function > Method > Constructor) to preserve the intuition that
   *     class-level names are usually what the user wanted.
   *
   * Capped at 1.0. Intentionally simple and inspectable — a future v2 can
   * plug in BM25/embedding signals here without changing the surrounding
   * resolver shape.
   */
  private scoreCandidate(
    c: { kind: string; filePath: string },
    hints: { file_path?: string; kind?: string },
  ): number {
    let s = 0.5;
    if (hints.file_path && c.filePath && typeof c.filePath === 'string') {
      if (c.filePath.toLowerCase().includes(hints.file_path.toLowerCase())) {
        s += 0.4;
      }
    }
    if (hints.kind && c.kind === hints.kind) {
      s += 0.2;
    }
    if (!hints.kind) {
      const priority: Record<string, number> = {
        Class: 5,
        Interface: 4,
        Function: 3,
        Method: 2,
        Constructor: 1,
      };
      s += (priority[c.kind] ?? 0) * 0.02;
    }
    return Math.min(1.0, s);
  }

  /**
   * Shared symbol resolver used by `context` and `impact`.
   *
   * Returns one of:
   *   - `{ kind: 'ok', symbol, resolvedLabel }` — single confident match
   *     (either direct UID, only one candidate after filtering, Class/
   *     Constructor collapse, or a top-scoring candidate with a clear gap
   *     to the runner-up).
   *   - `{ kind: 'ambiguous', candidates }` — multiple viable matches,
   *     sorted by score desc. Each candidate carries a relevance score.
   *   - `{ kind: 'not_found' }` — no matches at all.
   *
   * Preserves the #480 Class/Constructor preference: when the only
   * ambiguity is between a Class and its own Constructor (same name,
   * same filePath), the Class wins silently.
   */
  private async resolveSymbolCandidates(
    repo: RepoHandle,
    query: { uid?: string; name?: string; include_content?: boolean },
    hints: { file_path?: string; kind?: string },
  ): Promise<
    | {
        kind: 'ok';
        symbol: {
          id: string;
          name: string;
          type: string;
          filePath: string;
          startLine: number;
          endLine: number;
          content?: string;
        };
        resolvedLabel: string;
      }
    | {
        kind: 'ambiguous';
        candidates: Array<{
          id: string;
          name: string;
          type: string;
          filePath: string;
          startLine: number;
          endLine: number;
          score: number;
        }>;
      }
    | { kind: 'not_found' }
  > {
    const { uid, name, include_content } = query;
    const selectClause = `n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}`;

    // Direct UID — zero-ambiguity path.
    if (uid) {
      const rows = await executeParameterized(
        repo.lbugPath,
        `MATCH (n {id: $uid}) RETURN ${selectClause} LIMIT 1`,
        { uid },
      );
      if (rows.length === 0) return { kind: 'not_found' };
      const r = rows[0] as any;
      const symbol = {
        id: (r.id ?? r[0]) as string,
        name: (r.name ?? r[1]) as string,
        type: (r.type ?? r[2] ?? '') as string,
        filePath: (r.filePath ?? r[3]) as string,
        startLine: (r.startLine ?? r[4]) as number,
        endLine: (r.endLine ?? r[5]) as number,
        ...(include_content ? { content: (r.content ?? r[6]) as string | undefined } : {}),
      };
      // Same LadybugDB label-enrichment as the name-based path: a UID
      // pointing at a Class must still surface `type: 'Class'` so impact's
      // Class/Interface BFS seed fires. No-op when type is already set.
      await this.enrichCandidateLabels(repo, [symbol]);
      return { kind: 'ok', symbol, resolvedLabel: symbol.type };
    }

    if (!name) return { kind: 'not_found' };

    const isQualified = name.includes('/') || name.includes(':');
    let whereClause: string;
    const queryParams: Record<string, any> = { symName: name };
    if (hints.file_path) {
      whereClause = `WHERE n.name = $symName AND n.filePath CONTAINS $filePath`;
      queryParams.filePath = hints.file_path;
    } else if (isQualified) {
      whereClause = `WHERE n.id = $symName OR n.name = $symName`;
    } else {
      whereClause = `WHERE n.name = $symName`;
    }

    // LIMIT 20 (was 10) — scoring is the point now, so give the ranker
    // headroom instead of arbitrary truncation.
    const rows = await executeParameterized(
      repo.lbugPath,
      `MATCH (n) ${whereClause} RETURN ${selectClause} LIMIT 20`,
      queryParams,
    );

    if (rows.length === 0) return { kind: 'not_found' };

    // Normalise row shape across object / tuple returns from LadybugDB.
    const normalized = rows.map((r: any) => ({
      id: (r.id ?? r[0]) as string,
      name: (r.name ?? r[1]) as string,
      type: (r.type ?? r[2] ?? '') as string,
      filePath: (r.filePath ?? r[3]) as string,
      startLine: (r.startLine ?? r[4]) as number,
      endLine: (r.endLine ?? r[5]) as number,
      ...(include_content ? { content: (r.content ?? r[6]) as string | undefined } : {}),
    }));

    // Enrich labels for any candidates where `labels(n)[0]` came back empty.
    // LadybugDB returns an empty string for that projection on certain node
    // types (notably Class), which left downstream consumers (impact's
    // Class/Interface BFS seed, the kind-priority scoring bonus) unable to
    // distinguish a Class target from "unknown kind". One scoped UNION
    // across the five priority labels patches the type in-place without
    // per-candidate round-trips.
    await this.enrichCandidateLabels(repo, normalized);

    // Preserve #480 Class/Constructor collapse: if we have exactly one
    // Class (or Interface) candidate and one Constructor sharing name +
    // filePath, fold into the Class. This used to require a follow-up
    // label query because LadybugDB sometimes returns an empty labels()[0]
    // for Class nodes — enrichment above handles the empty-type case, but
    // the `type === 'Constructor'` gate still correctly triggers when a
    // Class and its Constructor share the name.
    if (!hints.kind && normalized.length > 1) {
      const ambiguousType = normalized.some((s) => s.type === '' || s.type === 'Constructor');
      if (ambiguousType) {
        const candidateIds = normalized.map((s) => s.id).filter(Boolean);
        for (const label of ['Class', 'Interface']) {
          const labelRows = await executeParameterized(
            repo.lbugPath,
            `MATCH (n:\`${label}\`) WHERE n.id IN $candidateIds RETURN n.id AS id LIMIT 1`,
            { candidateIds },
          ).catch(() => []);
          if (labelRows.length > 0) {
            const preferredId = (labelRows[0] as any).id ?? (labelRows[0] as any)[0];
            const preferred = normalized.find((s) => s.id === preferredId);
            if (preferred) {
              return {
                kind: 'ok',
                symbol: preferred,
                resolvedLabel: label,
              };
            }
          }
        }
      }
    }

    if (normalized.length === 1) {
      return {
        kind: 'ok',
        symbol: normalized[0],
        resolvedLabel: '',
      };
    }

    // Score, sort desc, stable tiebreak on shorter filePath then lex uid.
    const scored = normalized.map((s) => ({
      ...s,
      score: this.scoreCandidate({ kind: s.type, filePath: s.filePath || '' }, hints),
    }));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const fpA = (a.filePath || '').length;
      const fpB = (b.filePath || '').length;
      if (fpA !== fpB) return fpA - fpB;
      return String(a.id).localeCompare(String(b.id));
    });

    // Confident single-result: top score ≥ 0.95 AND beats runner-up by a
    // clear margin. This lets a very strong file_path/kind hint resolve
    // cleanly instead of forcing the caller through a disambiguation
    // round-trip.
    //
    // The gap threshold uses `> 0.09` rather than `>= 0.10` on purpose:
    // IEEE754 addition of the scoring terms (0.50 + 0.40 + 0.20 - 0.90
    // yields 0.09999999999999998, not exactly 0.10) would otherwise break
    // the comparison for legitimate "top is 1.00, runner is 0.90" cases.
    // The intent is a clearly-dominant winner; 0.09 is a large enough
    // margin to mean that unambiguously.
    //
    // The `scored.length >= 2` guard is defensive. The `normalized.length === 1`
    // early return above already handles the single-candidate path, so in
    // practice `scored` always has at least two elements by the time we get
    // here — keeping the guard means changes to the upstream early-return
    // logic cannot accidentally index out of bounds at `scored[1]`.
    if (scored.length >= 2 && scored[0].score >= 0.95 && scored[0].score - scored[1].score > 0.09) {
      return { kind: 'ok', symbol: scored[0], resolvedLabel: scored[0].type };
    }

    return { kind: 'ambiguous', candidates: scored };
  }

  /**
   * Context tool — 360-degree symbol view with categorized refs.
   * Disambiguation (ranked) when multiple symbols share a name.
   * UID-based direct lookup. No cluster in output.
   */
  private async context(
    repo: RepoHandle,
    params: {
      name?: string;
      uid?: string;
      file_path?: string;
      kind?: string;
      include_content?: boolean;
    },
  ): Promise<any> {
    try {
      return await this._contextImpl(repo, params);
    } catch (err: any) {
      const msg = (err instanceof Error ? err.message : String(err)) || 'Context query failed';
      if (isWalCorruptionError(err)) {
        return {
          error: msg,
          recoverySuggestion: WAL_RECOVERY_SUGGESTION,
        };
      }
      throw err;
    }
  }

  private async _contextImpl(
    repo: RepoHandle,
    params: {
      name?: string;
      uid?: string;
      file_path?: string;
      kind?: string;
      include_content?: boolean;
    },
  ): Promise<any> {
    await this.ensureInitialized(repo);

    const { name, uid, file_path, kind, include_content } = params;

    if (!name && !uid) {
      return { error: 'Either "name" or "uid" parameter is required.' };
    }

    const outcome = await this.resolveSymbolCandidates(
      repo,
      { uid, name, include_content },
      { file_path, kind },
    );

    if (outcome.kind === 'not_found') {
      return { error: `Symbol '${name || uid}' not found` };
    }

    if (outcome.kind === 'ambiguous') {
      return {
        status: 'ambiguous',
        message: `Found ${outcome.candidates.length} symbols matching '${name}'. Use uid, file_path, or kind to disambiguate.`,
        candidates: outcome.candidates.map((c) => ({
          uid: c.id,
          name: c.name,
          kind: c.type,
          filePath: c.filePath,
          line: toDisplayLine(c.startLine),
          score: Number(c.score.toFixed(2)),
        })),
      };
    }

    // Step 3: Build full context
    const sym = outcome.symbol;
    const resolvedLabel = outcome.resolvedLabel;
    const symId = sym.id;

    // Categorized incoming refs
    const incomingRows = await executeParameterized(
      repo.lbugPath,
      `
      MATCH (caller)-[r:CodeRelation]->(n {id: $symId})
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
      RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
      LIMIT 30
    `,
      { symId },
    );
    let typedPropertyRows: any[] = [];

    // Fix #480: Class/Interface nodes have no direct CALLS/IMPORTS edges —
    // those point to Constructor and File nodes respectively. Fetch those
    // extra incoming refs and merge them in so context() shows real callers.
    //
    // Determine if this is a Class/Interface node. If resolvedLabel was set
    // during disambiguation (Step 2), use it directly — no extra round-trip.
    // Otherwise fall back to a single label check only when the type field is
    // empty (LadybugDB labels(n)[0] limitation).
    const symRawType = sym.type || sym[2] || '';
    let isClassLike = resolvedLabel === 'Class' || resolvedLabel === 'Interface';
    if (!isClassLike && symRawType === '') {
      try {
        // Single UNION query instead of two serial round-trips.
        const typeCheck = await executeParameterized(
          repo.lbugPath,
          `
          MATCH (n:Class) WHERE n.id = $symId RETURN 'Class' AS label LIMIT 1
          UNION ALL
          MATCH (n:Interface) WHERE n.id = $symId RETURN 'Interface' AS label LIMIT 1
        `,
          { symId },
        );
        isClassLike = typeCheck.length > 0;
      } catch {
        /* not a Class/Interface node */
      }
    } else if (!isClassLike) {
      isClassLike = symRawType === 'Class' || symRawType === 'Interface';
    }

    if (isClassLike) {
      try {
        // Run incoming-ref queries in parallel — they are independent.
        const [ctorIncoming, fileIncoming, typedPropertyIncoming, typedProperties] =
          await Promise.all([
            executeParameterized(
              repo.lbugPath,
              `
            MATCH (n)-[hm:CodeRelation]->(ctor:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            MATCH (caller)-[r:CodeRelation]->(ctor)
            WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'ACCESSES']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `,
              { symId },
            ),
            executeParameterized(
              repo.lbugPath,
              `
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            MATCH (caller)-[r:CodeRelation]->(f)
            WHERE r.type IN ['CALLS', 'IMPORTS']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `,
              { symId },
            ),
            executeParameterized(
              repo.lbugPath,
              `
            MATCH (p:\`Property\`)
            WHERE p.declaredType = $name
               OR p.declaredType STARTS WITH $genericPrefix
               OR p.declaredType CONTAINS $genericArg
            MATCH (caller)-[r:CodeRelation]->(p)
            WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'ACCESSES']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `,
              {
                name: sym.name,
                genericPrefix: `${sym.name}<`,
                genericArg: `<${sym.name}>`,
              },
            ),
            executeParameterized(
              repo.lbugPath,
              `
            MATCH (p:\`Property\`)
            WHERE p.declaredType = $name
               OR p.declaredType STARTS WITH $genericPrefix
               OR p.declaredType CONTAINS $genericArg
            RETURN p.id AS uid, p.name AS name, p.filePath AS filePath, labels(p)[0] AS kind,
                   p.declaredType AS declaredType
            LIMIT 30
          `,
              {
                name: sym.name,
                genericPrefix: `${sym.name}<`,
                genericArg: `<${sym.name}>`,
              },
            ),
          ]);
        typedPropertyRows = typedProperties;

        // Deduplicate by (relType, uid) — a caller can have multiple relation
        // types to the same target (e.g. both IMPORTS and CALLS), and each
        // must be preserved so every category appears in the output.
        const seenKeys = new Set(
          incomingRows.map((r: any) => `${r.relType || r[0]}:${r.uid || r[1]}`),
        );
        for (const r of [...ctorIncoming, ...fileIncoming, ...typedPropertyIncoming]) {
          const key = `${r.relType || r[0]}:${r.uid || r[1]}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            incomingRows.push(r);
          }
        }
      } catch (e) {
        logQueryError('context:class-incoming-expansion', e);
      }
    }

    // Categorized outgoing refs
    const outgoingRows = await executeParameterized(
      repo.lbugPath,
      `
      MATCH (n {id: $symId})-[r:CodeRelation]->(target)
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
      RETURN r.type AS relType, target.id AS uid, target.name AS name, target.filePath AS filePath, labels(target)[0] AS kind
      LIMIT 30
    `,
      { symId },
    );

    // Process participation
    let processRows: any[] = [];
    try {
      processRows = await executeParameterized(
        repo.lbugPath,
        `
        MATCH (n {id: $symId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        RETURN p.id AS pid, p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
      `,
        { symId },
      );
    } catch (e) {
      logQueryError('context:process-participation', e);
    }

    // Helper to categorize refs
    const categorize = (rows: any[]) => {
      const cats: Record<string, any[]> = {};
      for (const row of rows) {
        const relType = (row.relType || row[0] || '').toLowerCase();
        const entry = {
          uid: row.uid || row[1],
          name: row.name || row[2],
          filePath: row.filePath || row[3],
          kind: row.kind || row[4],
        };
        if (!cats[relType]) cats[relType] = [];
        cats[relType].push(entry);
      }
      return cats;
    };

    // Method/Function/Constructor enrichment: fetch method-specific properties
    const symKind = isClassLike ? resolvedLabel || 'Class' : sym.type || sym[2];
    const isMethodLike =
      symKind === 'Method' || symKind === 'Function' || symKind === 'Constructor';

    // #1858 review F2 — start the epistemic boundary probe here (right after
    // `symKind` is known) so it runs CONCURRENTLY with the methodMetadata fetch
    // below, mirroring how _runImpactBFS overlaps it with the BFS. It is awaited
    // at result assembly. (It cannot start earlier — `symKind` is only computed
    // on this line, after the incoming/outgoing round-trips.)
    //
    // #1858 review F3 — pass an interface-preserving type, NOT `symKind`.
    // `symKind` collapses a single-resolved Interface to 'Class' (resolvedLabel
    // is '' on the single-candidate path), which would skip computeEpistemicBoundary's
    // `symType === 'Interface'` self-boundary branch and under-report a leaf
    // interface as 'exact'. `enrichCandidateLabels` runs BEFORE the single-candidate
    // early return and patches `sym.type` from '' to 'Interface' (LadybugDB returns
    // '' for labels()[0] on Interface/Class), so `sym.type` is the reliable signal
    // here — mirroring impact()'s `resolvedLabel || symbol.type` derivation. Do not
    // "fix" enrichment ordering; F3 depends on enrichment-before-early-return.
    const epistemicSymType = (resolvedLabel || sym.type || symKind || '') as string;
    const epistemicPromise = this.computeEpistemicBoundary(
      repo,
      symId,
      epistemicSymType,
      (sym.name || sym[1]) as string,
    );

    let methodMetadata: Record<string, unknown> | undefined;
    if (isMethodLike) {
      try {
        const metaRows = await executeParameterized(
          repo.lbugPath,
          `
          MATCH (n {id: $symId})
          RETURN n.visibility AS visibility, n.isStatic AS isStatic, n.isAbstract AS isAbstract,
                 n.isFinal AS isFinal, n.isVirtual AS isVirtual, n.isOverride AS isOverride,
                 n.isAsync AS isAsync, n.isPartial AS isPartial, n.returnType AS returnType,
                 n.parameterCount AS parameterCount, n.isVariadic AS isVariadic,
                 n.requiredParameterCount AS requiredParameterCount,
                 n.parameterTypes AS parameterTypes, n.annotations AS annotations
          LIMIT 1
        `,
          { symId },
        );
        if (metaRows.length > 0) {
          const row = metaRows[0];
          const meta: Record<string, unknown> = {};
          // Only include defined properties to distinguish "not applicable" from "not enriched"
          for (const key of Object.keys(row)) {
            const val = row[key];
            if (val !== null && val !== undefined) meta[key] = val;
          }
          if (Object.keys(meta).length > 0) methodMetadata = meta;
        }
      } catch {
        /* method metadata unavailable — omit silently */
      }
    }

    // #1858 — same epistemic boundary signal as impact(): when this symbol sits
    // behind an interface / indirection boundary, callers binding via DI or
    // dynamic dispatch are not reflected in `incoming`, so the view is a lower
    // bound. Additive; never suppresses a field. Resolved from the probe started
    // above (concurrent with methodMetadata).
    const epistemic = await epistemicPromise;

    return {
      status: 'found',
      symbol: {
        uid: sym.id || sym[0],
        name: sym.name || sym[1],
        kind: symKind,
        filePath: sym.filePath || sym[3],
        startLine: toDisplayLine(sym.startLine ?? sym[4]),
        endLine: toDisplayLine(sym.endLine ?? sym[5]),
        ...(include_content && (sym.content || sym[6]) ? { content: sym.content || sym[6] } : {}),
        ...(methodMetadata ? { methodMetadata } : {}),
      },
      ...epistemic,
      incoming: categorize(incomingRows),
      outgoing: categorize(outgoingRows),
      ...(typedPropertyRows.length > 0
        ? {
            typed_properties: typedPropertyRows.map((r: any) => ({
              uid: r.uid || r[0],
              name: r.name || r[1],
              filePath: r.filePath || r[2],
              kind: r.kind || r[3],
              declaredType: r.declaredType || r[4],
            })),
          }
        : {}),
      processes: processRows.map((r: any) => ({
        id: r.pid || r[0],
        name: r.label || r[1],
        step_index: r.step || r[2],
        step_count: r.stepCount || r[3],
      })),
    };
  }

  /**
   * Resolve a `target` (file path OR symbol/function name) into a BasicBlock
   * SOURCE-block anchor, shared by `explain` (TAINTED) and `pdg_query`
   * (CDG/REACHING_DEF) — both reconstruct the symbol↔block join the same way
   * (there is no Function→BasicBlock edge). #2188 review: extracted from two
   * near-identical copies that had DRIFTED — `_explainImpl` used a 0-based,
   * un-widened span window that dropped a function's final-line block and could
   * leak a neighbor's line-above block; this single resolver applies the correct
   * `[symStart+1, symEnd+1]` window (1-based BasicBlock startLine vs 0-based
   * symbol span) to BOTH callers.
   *
   * Returns a BARE `anchorClause` (no leading `AND`) so each caller composes its
   * own `WHERE`; `early` carries the not-found/ambiguous payload (caller returns
   * it verbatim). `target` / symbol names flow only through `queryParams` bind
   * params — never interpolated into Cypher.
   */
  private async resolveBlockAnchor(
    repo: RepoHandle,
    target: string,
    toolName: 'explain' | 'pdg_query' | 'impact',
  ): Promise<{
    anchorClause: string;
    queryParams: Record<string, unknown>;
    anchor: { file: string; symbol?: string; startLine?: number; endLine?: number };
    early?: Record<string, unknown>;
  }> {
    if (looksLikeFilePath(target)) {
      return {
        anchorClause:
          '(a.id STARTS WITH $idPrefix OR a.filePath = $targetPath OR a.filePath ENDS WITH $targetSuffix)',
        queryParams: {
          idPrefix: `BasicBlock:${target}:`,
          targetPath: target,
          targetSuffix: `/${target}`,
        },
        anchor: { file: target },
      };
    }
    const outcome = await this.resolveSymbolCandidates(repo, { name: target }, {});
    if (outcome.kind === 'not_found') {
      return {
        anchorClause: '',
        queryParams: {},
        anchor: { file: '' },
        early: { error: `Symbol '${target}' not found` },
      };
    }
    if (outcome.kind === 'ambiguous') {
      return {
        anchorClause: '',
        queryParams: {},
        anchor: { file: '' },
        early: {
          status: 'ambiguous',
          message: `Found ${outcome.candidates.length} symbols matching '${target}'. Re-call ${toolName} with the file path, or disambiguate via context() first.`,
          candidates: outcome.candidates.map((c) => ({
            uid: c.id,
            name: c.name,
            kind: c.type,
            filePath: c.filePath,
            line: toDisplayLine(c.startLine),
            score: Number(c.score.toFixed(2)),
          })),
        },
      };
    }
    const sym = outcome.symbol;
    const idPrefix = `BasicBlock:${sym.filePath}:`;
    if (
      typeof sym.startLine === 'number' &&
      typeof sym.endLine === 'number' &&
      sym.endLine >= sym.startLine
    ) {
      // BasicBlock startLine is 1-based; the symbol span is 0-based. Shift BOTH
      // bounds +1 so the window is the function's true block span: the lower +1
      // excludes a neighbor's block on the line directly above, the upper +1
      // keeps a guard/def/use on the final line (#2188 review).
      return {
        anchorClause:
          'a.id STARTS WITH $idPrefix AND a.startLine >= $symStart AND a.startLine <= $symEnd',
        queryParams: { idPrefix, symStart: sym.startLine + 1, symEnd: sym.endLine + 1 },
        // Display anchor is 1-based, matching the ambiguous-candidate branch and
        // the context/query/impact tools (#2380). This is display-only — the
        // BasicBlock join above uses the raw `sym.startLine + 1` in `symStart`.
        anchor: {
          file: sym.filePath,
          symbol: sym.name,
          startLine: toDisplayLine(sym.startLine),
          endLine: toDisplayLine(sym.endLine),
        },
      };
    }
    // No usable span — degrade to the file-level filter (documented).
    return {
      anchorClause: 'a.id STARTS WITH $idPrefix',
      queryParams: { idPrefix },
      anchor: { file: sym.filePath, symbol: sym.name },
    };
  }

  /**
   * Explain tool (#2083 M3 U6) — persisted taint-finding explanation.
   * WAL-aware wrapper mirroring `context`.
   */
  private async explain(
    repo: RepoHandle,
    params: { target?: string; limit?: number },
  ): Promise<any> {
    try {
      return await this._explainImpl(repo, params);
    } catch (err: any) {
      const msg = (err instanceof Error ? err.message : String(err)) || 'Explain query failed';
      if (isWalCorruptionError(err)) {
        return {
          error: msg,
          recoverySuggestion: WAL_RECOVERY_SUGGESTION,
        };
      }
      throw err;
    }
  }

  /**
   * Taint findings are persisted as `TAINTED` rows in CodeRelation whose
   * endpoints are BOTH BasicBlock nodes — the label anchor restricts every
   * query here to the BasicBlock→BasicBlock partition of the rel table
   * (which holds only the sparse, per-function-capped pdg layers), never a
   * global symbol-space scan (the S1 verdict; LadybugDB has no rel-property
   * index, so the label anchor IS the bound).
   *
   * Anchoring granularity:
   * - file target → BasicBlock id prefix (`BasicBlock:<filePath>:` — the
   *   shared `basicBlockId` template) with an exact-or-suffix path match so
   *   `vuln.ts` finds `src/vuln.ts`.
   * - symbol target → resolved via `resolveSymbolCandidates` (the context()
   *   path: ambiguous ⇒ ranked candidates, unknown ⇒ not-found), then the
   *   file id-prefix PLUS source-block startLine within the symbol's
   *   [startLine, endLine] span. Findings are intra-procedural, so filtering
   *   the SOURCE endpoint is sufficient — both endpoints share the function.
   *   Symbols without a line span degrade to the file-level filter.
   *
   * The per-finding `sinkKind` and hop path decode from the persisted
   * `reason` via the SHARED `taint/path-codec.ts` (the U4 write path encodes
   * with the same module — `;<kind>` header + ordered `variable:line` hops).
   */
  private async _explainImpl(
    repo: RepoHandle,
    params: { target?: string; limit?: number },
  ): Promise<any> {
    await this.ensureInitialized(repo);

    const rawLimit = params.limit ?? EXPLAIN_DEFAULT_LIMIT;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > EXPLAIN_MAX_LIMIT) {
      return {
        error: `Invalid "limit": expected an integer in [1, ${EXPLAIN_MAX_LIMIT}], got ${JSON.stringify(params.limit)}.`,
      };
    }
    const limit = rawLimit;

    const NO_TAINT_NOTE =
      'no taint layer — run gitnexus analyze --pdg to record taint findings for this repo';

    // Cheap meta probe: the TAINT layer exists iff the pdg stamp carries a
    // `taintModelVersion` (the field M3 added). An M1/M2-era `--pdg` index has
    // `meta.pdg` defined but no taintModelVersion — BasicBlock/REACHING_DEF
    // exist, zero TAINTED rows do — so it must surface the no-taint-layer hint,
    // not the generic "analyzed, nothing found" note. An unreadable meta (e.g.
    // a seeded test DB) falls through to the row-existence probe below.
    let pdgStamped: boolean | undefined;
    try {
      const meta = await loadMeta(path.dirname(repo.lbugPath));
      if (meta) pdgStamped = meta.pdg?.taintModelVersion !== undefined;
    } catch {
      /* meta unreadable — decide from the DB below */
    }
    if (pdgStamped === false) {
      return { findings: [], totalFindings: 0, note: NO_TAINT_NOTE };
    }

    // Resolve the optional anchor into a WHERE clause on the SOURCE block.
    const target = typeof params.target === 'string' ? params.target.trim() : '';
    let anchorClause = '';
    let queryParams: Record<string, unknown> = {};
    let anchor: { file: string; symbol?: string; startLine?: number; endLine?: number } | undefined;

    // Bounded by construction: the BasicBlock→BasicBlock partition holds only
    // the sparse pdg layers, TAINTED rows are per-function-capped at analyze
    // time, and the page is LIMIT-bounded (the limit is a validated integer —
    // interpolated because LadybugDB does not parameterize LIMIT).
    const runAnchoredQuery = async (): Promise<{ rows: unknown[]; totalFindings: number }> => {
      const matchClause = `
      MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
      WHERE r.type = 'TAINTED'${anchorClause ? ` AND ${anchorClause}` : ''}`;
      const [qRows, countRows] = await Promise.all([
        executeParameterized(
          repo.lbugPath,
          `${matchClause}
      RETURN a.id AS sourceBlockId, a.filePath AS file, a.startLine AS sourceStart,
             b.startLine AS sinkStart, r.reason AS reason, b.id AS sinkBlockId
      ORDER BY sourceBlockId, sinkBlockId, reason
      LIMIT ${limit}`,
          queryParams,
        ),
        executeParameterized(
          repo.lbugPath,
          `${matchClause}
      RETURN COUNT(*) AS total`,
          queryParams,
        ),
      ]);
      return {
        rows: qRows,
        totalFindings: Number((countRows[0] as any)?.total ?? (countRows[0] as any)?.[0] ?? 0),
      };
    };

    if (target) {
      // Shared symbol↔block anchor resolver (#2188): file id-prefix OR symbol
      // span, with the corrected [symStart+1, symEnd+1] window. A bare/dotted
      // symbol name resolves as a symbol rather than silently file-anchoring.
      const resolved = await this.resolveBlockAnchor(repo, target, 'explain');
      if (resolved.early) return resolved.early;
      anchorClause = resolved.anchorClause;
      queryParams = resolved.queryParams;
      anchor = resolved.anchor;
    }

    const { rows, totalFindings } = await runAnchoredQuery();

    // M4 (#2084 U7): cross-function findings ride TAINT_PATH edges (Function/
    // Method → Function/Method), separate from the intra-procedural TAINTED
    // BasicBlock rows above. Enumerate them too so `explain` is the discovery
    // surface for interprocedural flows (TAINT_PATH stays out of
    // VALID_RELATION_TYPES + the web schema, like TAINTED). File-anchored:
    // filter on the source function's file; symbol-anchored: either endpoint
    // matches the symbol name; anchorless: all (bounded by LIMIT). Computed
    // BEFORE the no-taint early returns — a repo with ONLY cross-function
    // findings (no intra-procedural TAINTED rows) must not look empty.
    const runInterprocQuery = async (): Promise<{ findings: any[]; total: number }> => {
      const where: string[] = [`r.type = 'TAINT_PATH'`];
      const p: Record<string, unknown> = {};
      if (anchor?.symbol) {
        where.push('(a.name = $ipSym OR b.name = $ipSym)');
        p.ipSym = anchor.symbol;
      } else if (anchor?.file) {
        // Match EITHER endpoint's file — a cross-function flow anchored on the
        // SINK's file (b) is as relevant as one anchored on the source's (a).
        where.push(
          '(a.filePath = $ipFile OR a.filePath ENDS WITH $ipSuffix OR ' +
            'b.filePath = $ipFile OR b.filePath ENDS WITH $ipSuffix)',
        );
        p.ipFile = anchor.file;
        p.ipSuffix = `/${anchor.file}`;
      }
      const matchClause = `MATCH (a)-[r:CodeRelation]->(b)\n      WHERE ${where.join(' AND ')}`;
      // Page query + a separate COUNT (#2084 review P2-4): the page is
      // LIMIT-capped, so its row count cannot stand in for the true total —
      // run a COUNT with the same WHERE (no LIMIT) like the intra layer does.
      const [ipRows, ipCountRows] = await Promise.all([
        executeParameterized(
          repo.lbugPath,
          `${matchClause}
      RETURN a.filePath AS file, a.name AS sourceFn, a.startLine AS sourceLine,
             b.name AS sinkFn, b.startLine AS sinkLine, r.reason AS reason
      ORDER BY sourceFn, sinkFn, reason
      LIMIT ${limit}`,
          p,
        ),
        executeParameterized(repo.lbugPath, `${matchClause}\n      RETURN COUNT(*) AS total`, p),
      ]);
      const total = Number((ipCountRows[0] as any)?.total ?? (ipCountRows[0] as any)?.[0] ?? 0);
      const findings = ipRows.map((r: any) => {
        const decoded = decodeTaintPath(r.reason ?? r[5]);
        const hops = decoded.ok
          ? decoded.hops.map((h) => ({ function: h.variable, line: h.line }))
          : [];
        return {
          interprocedural: true,
          file: String(r.file ?? r[0] ?? ''),
          sinkKind: decoded.ok ? (decoded.kind ?? 'unknown') : 'unknown',
          source: { function: String(r.sourceFn ?? r[1] ?? ''), line: r.sourceLine ?? r[2] },
          sink: { function: String(r.sinkFn ?? r[3] ?? ''), line: r.sinkLine ?? r[4] },
          hops,
          ...(decoded.ok && decoded.truncated ? { pathIncomplete: true } : {}),
        };
      });
      return { findings, total };
    };
    const { findings: interprocFindings, total: interprocTotal } = await runInterprocQuery();

    if (
      totalFindings === 0 &&
      interprocFindings.length === 0 &&
      pdgStamped === undefined &&
      !target
    ) {
      // Meta was unreadable and the repo-wide enumerate (both layers) found
      // nothing — the counts above WERE the existence probe; surface the hint.
      return { findings: [], totalFindings: 0, note: NO_TAINT_NOTE };
    }
    if (
      totalFindings === 0 &&
      interprocFindings.length === 0 &&
      pdgStamped === undefined &&
      target
    ) {
      // Anchored miss with unreadable meta: one extra bounded probe decides
      // "no findings for this anchor" vs "no taint layer at all". Probe BOTH
      // intra (TAINTED) and inter (TAINT_PATH) existence.
      const probe = await executeParameterized(
        repo.lbugPath,
        `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock) WHERE r.type = 'TAINTED' RETURN r.reason AS reason LIMIT 1`,
        {},
      );
      const ipProbe =
        probe.length === 0
          ? await executeParameterized(
              repo.lbugPath,
              `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = 'TAINT_PATH' RETURN r.reason AS reason LIMIT 1`,
              {},
            )
          : [];
      if (probe.length === 0 && ipProbe.length === 0) {
        return { findings: [], totalFindings: 0, note: NO_TAINT_NOTE };
      }
    }

    const findings = rows.map((r: any) => {
      const sourceBlockId = String(r.sourceBlockId ?? r[0] ?? '');
      const file = String(r.file ?? r[1] ?? '');
      const sourceStart = (r.sourceStart ?? r[2]) as number | undefined;
      const sinkStart = (r.sinkStart ?? r[3]) as number | undefined;
      const reason = r.reason ?? r[4];
      // basicBlockId = `BasicBlock:<filePath>:<fnLine>:<fnCol>:<blockIdx>` —
      // split from the RIGHT (the filePath may itself contain ':').
      const idParts = sourceBlockId.split(':');
      const fnLine = Number(idParts[idParts.length - 3]);
      const decoded = decodeTaintPath(reason);
      if (!decoded.ok) {
        // Unreadable reason (foreign/corrupt row): surface the finding's
        // existence with its block anchors, never throw.
        return {
          file,
          ...(Number.isInteger(fnLine) ? { functionLine: fnLine } : {}),
          sinkKind: 'unknown',
          source: { line: sourceStart },
          sink: { line: sinkStart },
          hops: [],
          pathIncomplete: true,
        };
      }
      const hops = decoded.hops.map((h) => ({
        variable: h.variable,
        line: h.line,
        ...(h.viaCall ? { viaCall: true } : {}),
      }));
      const first = hops[0];
      const last = hops[hops.length - 1];
      return {
        file,
        ...(Number.isInteger(fnLine) ? { functionLine: fnLine } : {}),
        sinkKind: decoded.kind ?? 'unknown',
        source: first ? { variable: first.variable, line: first.line } : { line: sourceStart },
        sink: { line: last?.line ?? sinkStart },
        hops,
        ...(decoded.truncated ? { pathIncomplete: true } : {}),
      };
    });

    // Combine both layers and re-apply the page LIMIT to the union — each
    // layer was queried with its own LIMIT, so the union can hold up to 2×;
    // cap it so `findings.length` honours the caller's `limit`. `truncated`
    // reflects EITHER layer overflowing OR the union being trimmed here, and
    // `totalFindings` counts both layers' matched rows (the intra COUNT plus
    // the interproc rows returned — interproc has no separate COUNT, so a
    // capped interproc layer is reflected via `truncated`, never undercounted
    // into a false "complete" signal). Review: code-review #2/#4 (explain
    // accounting + sink-file anchoring) — both layers now accounted.
    const combined = [...findings, ...interprocFindings];
    const pageFindings = combined.length > limit ? combined.slice(0, limit) : combined;
    // Truncated iff EITHER layer overflowed its own LIMIT (strict `>` — exactly
    // `limit` rows is not truncated), OR the combined union was trimmed to the
    // page (#2084 review P2-4). `totalFindings` uses the interproc COUNT, not
    // the capped slice length, so it never undercounts.
    const truncated =
      totalFindings > findings.length ||
      interprocTotal > interprocFindings.length ||
      combined.length > pageFindings.length;

    return {
      ...(anchor ? { anchor } : {}),
      findings: pageFindings,
      totalFindings: totalFindings + interprocTotal,
      ...(truncated ? { truncated: true } : {}),
      note: 'Intra-procedural (TAINTED, statement hops) AND cross-function (TAINT_PATH, function hops, `interprocedural: true`) flows are modeled. Closure/callback, property/field, and implicit flows are NOT modeled; absence of a finding is not proof of safety. Cross-function findings are context-insensitive and may over-attribute among same-named callees. SANITIZES (kill) edges are queryable via cypher.',
    };
  }

  private async pdgQuery(
    repo: RepoHandle,
    params: { mode?: string; target?: string; variable?: string; limit?: number },
  ): Promise<any> {
    try {
      return await this._pdgQueryImpl(repo, params);
    } catch (err: any) {
      const msg = (err instanceof Error ? err.message : String(err)) || 'pdg_query failed';
      if (isWalCorruptionError(err)) {
        return { error: msg, recoverySuggestion: WAL_RECOVERY_SUGGESTION };
      }
      throw err;
    }
  }

  /**
   * Query the persisted PDG (#2086 M6) — the control/data-dependence analog of
   * `explain`. `controls` reads CDG ("under what condition does X run?", branch
   * sense 'T'|'F' in `reason`); `flows` reads REACHING_DEF (def→use, variable
   * name in `reason`). Intra-procedural, basic-block granular.
   *
   * Bounded by construction: the BasicBlock→BasicBlock partition holds only the
   * sparse, per-function-capped pdg layers, the query is anchored to one file/
   * symbol, and the page is LIMIT-bounded (validated integer, interpolated
   * because LadybugDB does not parameterize LIMIT). LadybugDB has no rel-
   * property index, so the anchor IS the bound — there is no anchorless mode.
   *
   * Symbol↔block join: there is no Function→BasicBlock edge; the SOURCE block
   * (`a` — controller for CDG, def for REACHING_DEF) is filtered by the
   * BasicBlock id-prefix (`basicBlockId` template) plus its `startLine` within
   * the symbol's span. BasicBlock `startLine` is 1-based while symbol-node
   * `startLine`/`endLine` are 0-based, so BOTH bounds are shifted +1
   * (`[symStart+1, symEnd+1]`) onto the block basis: the upper +1 keeps a
   * guard/def/use on the function's final line, and the lower +1 excludes an
   * adjacent function's block on the line directly above (#2188 review). Both
   * endpoints share the function (intra-procedural), so filtering the source
   * endpoint suffices.
   */
  private async _pdgQueryImpl(
    repo: RepoHandle,
    params: { mode?: string; target?: string; variable?: string; limit?: number } = {},
  ): Promise<any> {
    await this.ensureInitialized(repo);

    // Mode validation — the JSON-schema enum is advisory for MCP clients, so
    // the backend enforces it (an unhandled mode would otherwise fall through).
    const mode = params.mode;
    if (mode !== 'controls' && mode !== 'flows') {
      return {
        error: `Invalid "mode": expected "controls" or "flows", got ${JSON.stringify(params.mode)}.`,
      };
    }

    const rawLimit = params.limit ?? PDG_QUERY_DEFAULT_LIMIT;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > PDG_QUERY_MAX_LIMIT) {
      return {
        error: `Invalid "limit": expected an integer in [1, ${PDG_QUERY_MAX_LIMIT}], got ${JSON.stringify(params.limit)}.`,
      };
    }
    const limit = rawLimit;

    // PDG queries are always anchored (no rel-property index ⇒ an unanchored
    // basic-block path scan is unbounded). `target` is required.
    const target = typeof params.target === 'string' ? params.target.trim() : '';
    if (!target) {
      return {
        error:
          'pdg_query requires a "target" (a file path or symbol/function name) — PDG queries are always anchored.',
      };
    }

    const edgeType = mode === 'controls' ? 'CDG' : 'REACHING_DEF';
    // Definitive: the meta stamp says this layer was never recorded.
    const NO_PDG_NOTE = `no PDG layer — run gitnexus analyze --pdg to record ${edgeType} edges for this repo`;
    // Inconclusive: meta is unreadable AND a global probe found zero rows of this
    // edge type — but a genuinely edge-free layer (all-linear functions) looks
    // identical to a missing one, so don't assert absence (#2188 review).
    const PDG_LAYER_UNKNOWN_NOTE = `no ${edgeType} edges found for this target; PDG layer status unknown — was this repo indexed with gitnexus analyze --pdg?`;

    // Cheap meta probe: the layer exists iff the pdg stamp carries the
    // mode-relevant cap (maxCdgEdgesPerFunction for CDG, maxReachingDef…
    // for REACHING_DEF). Absent ⇒ the no-layer hint without a DB scan.
    // `pdgStampForMode` is the shared meta read (the both-caps `pdgLayerStatus`
    // helper consumes the same underlying read for impact); here we project it
    // down to this one mode's cap, preserving the tri-state `boolean | undefined`
    // contract byte-for-byte: `false` ⇒ definitive no-layer (short-circuit
    // below), `true` ⇒ proceed, `undefined` ⇒ meta unreadable, defer to the
    // post-anchored-query probe (Feasibility Issue 4).
    const pdgStamped = await pdgStampForMode(repo.lbugPath, mode);
    if (pdgStamped === false) {
      return { mode, results: [], total: 0, note: NO_PDG_NOTE };
    }

    // Resolve the anchor on the SOURCE block via the shared resolver also used
    // by explain (#2188): file id-prefix OR symbol span on the corrected
    // [symStart+1, symEnd+1] window. `target` is required, so the early cases
    // (not-found/ambiguous) return here and `anchor`/`anchorClause` are always
    // set below (anchor stays non-optional — no `| undefined` — #2188 CodeQL).
    const resolved = await this.resolveBlockAnchor(repo, target, 'pdg_query');
    if (resolved.early) return resolved.early;
    const { anchorClause, anchor } = resolved;
    const queryParams = resolved.queryParams;

    // Optional variable filter (flows mode) — REACHING_DEF stores the variable
    // name in `reason`. FU-B-2 prefixes the name with a `<name>|1:<def>:<use>`
    // annotation (name FIRST), so match BOTH a legacy bare-name reason (`=`) AND
    // an annotated one (`STARTS WITH <name>|`). Source identifiers never contain
    // `|`, so the `<name>|` prefix is exact (it cannot collide with a longer name
    // — `ab|…` is not a prefix of `abc|…`).
    let reasonClause = '';
    if (mode === 'flows' && typeof params.variable === 'string' && params.variable.trim()) {
      reasonClause = ' AND (r.reason = $variable OR r.reason STARTS WITH $variablePrefix)';
      const variable = params.variable.trim();
      queryParams.variable = variable;
      queryParams.variablePrefix = `${variable}|`;
    }

    // edgeType is a hardcoded per-mode literal (never user input); `target` /
    // `variable` flow only through bind params (no Cypher interpolation).
    const matchClause = `
      MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
      WHERE r.type = '${edgeType}' AND ${anchorClause}${reasonClause}`;
    const [rows, countRows] = await Promise.all([
      executeParameterized(
        repo.lbugPath,
        `${matchClause}
      RETURN a.id AS srcId, a.startLine AS srcLine, b.startLine AS dstLine, b.text AS dstText, r.reason AS reason
      ORDER BY srcId, dstLine, reason
      LIMIT ${limit}`,
        queryParams,
      ),
      executeParameterized(
        repo.lbugPath,
        `${matchClause}\n      RETURN COUNT(*) AS total`,
        queryParams,
      ),
    ]);
    const total = Number((countRows[0] as any)?.total ?? (countRows[0] as any)?.[0] ?? 0);

    // Unreadable meta + anchored miss: one bounded probe distinguishes "no rows
    // for this anchor" from "no rows of this edge type at all". With meta
    // unreadable we cannot tell a missing layer from an edge-free one, so the
    // note is the inconclusive "status unknown" form, not the definitive
    // NO_PDG_NOTE (which is reserved for the meta-stamped absence above).
    if (total === 0 && pdgStamped === undefined) {
      const probe = await executeParameterized(
        repo.lbugPath,
        `MATCH (:BasicBlock)-[r:CodeRelation]->(:BasicBlock) WHERE r.type = '${edgeType}' RETURN r.reason AS reason LIMIT 1`,
        {},
      );
      if (probe.length === 0) return { mode, results: [], total: 0, note: PDG_LAYER_UNKNOWN_NOTE };
    }

    // basicBlockId = `BasicBlock:<filePath>:<fnLine>:<fnCol>:<blockIdx>` — split
    // from the RIGHT (filePath may contain ':'). Shared module-scope `fnLineOf`.
    const results =
      mode === 'controls'
        ? rows.map((r: any) => {
            const fnLine = fnLineOf(String(r.srcId ?? r[0] ?? ''));
            const dstText = String(r.dstText ?? r[3] ?? '');
            // A CDG edge into an early-exit block is a guard clause (subsumes
            // #559): the controller predicate gates the dependent via `label`.
            const isGuardExit = /^\s*(return|throw|continue|break)\b/.test(dstText);
            return {
              ...(Number.isInteger(fnLine) ? { functionLine: fnLine } : {}),
              controller: { line: (r.srcLine ?? r[1]) as number | undefined },
              dependent: { line: (r.dstLine ?? r[2]) as number | undefined, text: dstText },
              label: String(r.reason ?? r[4] ?? ''),
              ...(isGuardExit ? { guard: true } : {}),
            };
          })
        : rows.map((r: any) => {
            const fnLine = fnLineOf(String(r.srcId ?? r[0] ?? ''));
            // FU-B-2: REACHING_DEF `reason` is `<name>` (legacy) or
            // `<name>|1:<defLine>:<useLine>` — decode to surface the bare
            // variable name, not the encoded annotation.
            const variable = decodeReachingDefReason(r.reason ?? r[4] ?? '').name;
            return {
              ...(Number.isInteger(fnLine) ? { functionLine: fnLine } : {}),
              variable,
              def: { line: (r.srcLine ?? r[1]) as number | undefined },
              use: {
                line: (r.dstLine ?? r[2]) as number | undefined,
                text: String(r.dstText ?? r[3] ?? ''),
              },
            };
          });

    return {
      mode,
      anchor,
      results,
      total,
      ...(total > results.length ? { truncated: true } : {}),
    };
  }

  /**
   * Legacy explore — kept for backwards compatibility with resources.ts.
   * Routes cluster/process types to direct graph queries.
   */
  private async explore(
    repo: RepoHandle,
    params: { name: string; type: 'symbol' | 'cluster' | 'process' },
  ): Promise<any> {
    await this.ensureInitialized(repo);
    const { name, type } = params;

    if (type === 'symbol') {
      return this.context(repo, { name });
    }

    if (type === 'cluster') {
      const clusters = await executeParameterized(
        repo.lbugPath,
        `
        MATCH (c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
      `,
        { clusterName: name },
      );
      if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0],
        label: c.label || c[1],
        heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3],
        symbolCount: c.symbolCount || c[4],
      }));

      let totalSymbols = 0,
        weightedCohesion = 0;
      for (const c of rawClusters) {
        const s = c.symbolCount || 0;
        totalSymbols += s;
        weightedCohesion += (c.cohesion || 0) * s;
      }

      const members = await executeParameterized(
        repo.lbugPath,
        `
        MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
        LIMIT 30
      `,
        { clusterName: name },
      );

      return {
        cluster: {
          id: rawClusters[0].id,
          label: rawClusters[0].heuristicLabel || rawClusters[0].label,
          heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
          cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
          symbolCount: totalSymbols,
          subCommunities: rawClusters.length,
        },
        members: members.map((m: any) => ({
          name: m.name || m[0],
          type: m.type || m[1],
          filePath: m.filePath || m[2],
        })),
      };
    }

    if (type === 'process') {
      const processes = await executeParameterized(
        repo.lbugPath,
        `
        MATCH (p:Process)
        WHERE p.label = $processName OR p.heuristicLabel = $processName
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        LIMIT 1
      `,
        { processName: name },
      );
      if (processes.length === 0) return { error: `Process '${name}' not found` };

      const proc = processes[0];
      const procId = proc.id || proc[0];
      const steps = await executeParameterized(
        repo.lbugPath,
        `
        MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
        RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
        ORDER BY r.step
      `,
        { procId },
      );

      return {
        process: {
          id: procId,
          label: proc.label || proc[1],
          heuristicLabel: proc.heuristicLabel || proc[2],
          processType: proc.processType || proc[3],
          stepCount: proc.stepCount || proc[4],
        },
        steps: steps.map((s: any) => ({
          step: s.step || s[3],
          name: s.name || s[0],
          type: s.type || s[1],
          filePath: s.filePath || s[2],
        })),
      };
    }

    return { error: 'Invalid type. Use: symbol, cluster, or process' };
  }

  /**
   * Detect changes — git-diff based impact analysis.
   * Maps changed lines to indexed symbols, then finds affected processes.
   */
  private async detectChanges(
    repo: RepoHandle,
    params: {
      scope?: string;
      base_ref?: string;
      worktree?: string;
    },
  ): Promise<any> {
    await this.ensureInitialized(repo);

    const scope = params.scope || 'unstaged';
    const { execFileSync } = await import('child_process');

    // Build git diff args based on scope (using execFileSync to avoid shell injection)
    let diffArgs: string[];
    switch (scope) {
      case 'staged':
        diffArgs = ['diff', '--staged', '-U0'];
        break;
      case 'all':
        diffArgs = ['diff', 'HEAD', '-U0'];
        break;
      case 'compare':
        if (!params.base_ref) return { error: 'base_ref is required for "compare" scope' };
        diffArgs = ['diff', params.base_ref, '-U0'];
        break;
      case 'unstaged':
      default:
        diffArgs = ['diff', '-U0'];
        break;
    }

    let diffOutput: string;
    try {
      // Resolve the cwd for git diff.
      //
      // In a linked worktree (e.g. /repo/wt-feature/), the user's staged and
      // unstaged changes live in that worktree's separate working directory and
      // index. Running `git diff` from the canonical repo root sees a different
      // working tree and returns empty output.
      //
      // Resolution order (see resolveWorktreeCwd for details):
      //   1. params.worktree — explicit override, validated against the
      //      registered repo's canonical root.
      //   2. Auto-detect — if the server's launch cwd (process.cwd()) is a
      //      linked worktree of the same canonical repo, use its git root.
      //   3. repo.repoPath — fallback (original behaviour, handled inside
      //      resolveWorktreeCwd when no worktree is detected).
      //
      // Start with the auto-detected value; override with the validated
      // explicit param when provided. This avoids a dead initial assignment.
      let diffCwd = resolveWorktreeCwd(repo.repoPath, process.cwd());
      if (params.worktree) {
        if (!path.isAbsolute(params.worktree)) {
          return {
            error: `worktree must be an absolute path, got: "${params.worktree}"`,
          };
        }
        const providedResolved = path.resolve(params.worktree);
        const repoCanonical = getCanonicalRepoRoot(repo.repoPath);
        if (!repoCanonical) {
          return {
            error: `Could not determine canonical root for repo "${repo.repoPath}". Is git available?`,
          };
        }
        const worktreeCanonical = getCanonicalRepoRoot(providedResolved);
        if (!worktreeCanonical || tryRealpath(worktreeCanonical) !== tryRealpath(repoCanonical)) {
          return {
            error: `worktree "${params.worktree}" is not a worktree of repo "${repo.repoPath}". Ensure the path is inside the same git repository.`,
          };
        }
        diffCwd = providedResolved;
      }

      // maxBuffer raised from Node's 1MB default to 256MB to avoid ENOBUFS on
      // repos with large unstaged/untracked diffs (e.g. unignored build folders).
      // See issue: spawnSync git ENOBUFS in detect_changes(scope="unstaged").
      diffOutput = execFileSync('git', diffArgs, {
        cwd: diffCwd,
        encoding: 'utf-8',
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (err: any) {
      return { error: `Git diff failed: ${err.message}` };
    }

    const fileDiffs: FileDiff[] = parseDiffHunks(diffOutput);

    if (fileDiffs.length === 0) {
      return {
        summary: {
          changed_count: 0,
          affected_count: 0,
          risk_level: 'none',
          message: 'No changes detected.',
        },
        changed_symbols: [],
        affected_processes: [],
      };
    }

    // Map diff hunks to indexed symbols via range overlap
    const changedSymbols: any[] = [];
    // Set if a swallowed graph query fails below — surfaces `partial:true` so a
    // degraded run cannot report a false-clean `risk_level:'low'` (#2283).
    let queryDegraded = false;
    for (const fileDiff of fileDiffs) {
      if (fileDiff.hunks.length === 0) continue;

      // Build range overlap conditions for all hunks in this file
      const overlapConditions = fileDiff.hunks
        .map((_, i) => `(n.startLine <= $hunkEnd${i} AND n.endLine >= $hunkStart${i})`)
        .join(' OR ');

      const queryParams: Record<string, any> = { filePath: fileDiff.filePath };
      fileDiff.hunks.forEach((hunk, i) => {
        queryParams[`hunkStart${i}`] = hunk.startLine;
        queryParams[`hunkEnd${i}`] = hunk.endLine;
      });

      // Exclude BasicBlock rows by id prefix: on a --pdg index every edited
      // function otherwise contributes N nameless BasicBlock pseudo-"symbols"
      // (they carry filePath/start/end but no name), inflating changed_count
      // and risk level with rows no consumer can act on (#2082 U7). Blocks
      // are implementation substrate, not symbols — the owning Function row
      // already represents the change. The id prefix (`BasicBlock:<file>:…`,
      // cfg/emit.ts basicBlockId) beats a label predicate (`labels(n)[0]` is
      // known to come back empty for several node types — see
      // enrichCandidateLabels) AND beats `n.name IS NOT NULL` (which would
      // also drop legitimate symbols whose name loaded as NULL, e.g.
      // quoted-empty CSV fields for anonymous constructs).
      const symbolQuery = `
        MATCH (n) WHERE n.filePath ENDS WITH $filePath
          AND NOT n.id STARTS WITH 'BasicBlock:'
          AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL
          AND (${overlapConditions})
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type,
               n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
      `;

      try {
        const rows = await executeParameterized(repo.lbugPath, symbolQuery, queryParams);
        for (const sym of rows) {
          changedSymbols.push({
            id: sym.id || sym[0],
            name: sym.name || sym[1],
            type: sym.type || sym[2],
            filePath: sym.filePath || sym[3],
            change_type: 'touched',
          });
        }
      } catch (e) {
        logQueryError('detect-changes:file-symbols', e);
        // The symbol query failed: changedSymbols stays empty and the result
        // would otherwise look like a clean no-op (`changed_count:0`,
        // `risk_level:'low'`). detect_changes is the pre-commit safety gate, so
        // flag the result `partial` rather than let a swallowed failure
        // masquerade as "nothing changed" (#2283).
        queryDegraded = true;
      }
    }

    // Find affected processes -- single batched query instead of N+1
    const affectedProcesses = new Map<string, any>();
    if (changedSymbols.length > 0) {
      const symIds = changedSymbols.map((s) => s.id);
      const symNameById = new Map(changedSymbols.map((s) => [s.id, s.name]));
      try {
        const procs = await executeParameterized(
          repo.lbugPath,
          `
          MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE n.id IN $ids
          RETURN n.id AS nodeId, p.id AS pid, p.heuristicLabel AS label,
                 p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `,
          { ids: symIds },
        );
        for (const proc of procs) {
          const nodeId = proc.nodeId || proc[0];
          const pid = proc.pid || proc[1];
          if (!affectedProcesses.has(pid)) {
            affectedProcesses.set(pid, {
              id: pid,
              name: proc.label || proc[2],
              process_type: proc.processType || proc[3],
              step_count: proc.stepCount || proc[4],
              changed_steps: [],
            });
          }
          affectedProcesses.get(pid)!.changed_steps.push({
            symbol: symNameById.get(nodeId) ?? nodeId,
            step: proc.step || proc[5],
          });
        }
      } catch (e) {
        logQueryError('detect-changes:process-lookup', e);
        queryDegraded = true;
      }
    }

    const processCount = affectedProcesses.size;
    const risk =
      processCount === 0
        ? 'low'
        : processCount <= 5
          ? 'medium'
          : processCount <= 15
            ? 'high'
            : 'critical';

    return {
      summary: {
        changed_count: changedSymbols.length,
        affected_count: processCount,
        changed_files: fileDiffs.length,
        risk_level: risk,
      },
      changed_symbols: changedSymbols,
      affected_processes: Array.from(affectedProcesses.values()),
      // A swallowed query failure makes the counts/risk above incomplete — tell
      // the caller so the safety gate isn't trusted as a clean result (#2283).
      ...(queryDegraded && { partial: true }),
    };
  }

  /**
   * Rename tool — multi-file coordinated rename using graph + text search.
   * Graph refs are tagged "graph" (high confidence).
   * Additional refs found via text search are tagged "text_search" (lower confidence).
   */
  private async rename(
    repo: RepoHandle,
    params: {
      symbol_name?: string;
      symbol_uid?: string;
      new_name: string;
      file_path?: string;
      dry_run?: boolean;
    },
  ): Promise<any> {
    await this.ensureInitialized(repo);

    const { new_name, file_path } = params;
    const dry_run = params.dry_run ?? true;

    if (!params.symbol_name && !params.symbol_uid) {
      return { error: 'Either symbol_name or symbol_uid is required.' };
    }

    /** Guard: ensure a file path resolves within the repo root (prevents path traversal) */
    const assertSafePath = (filePath: string): string => {
      const full = path.resolve(repo.repoPath, filePath);
      if (!full.startsWith(repo.repoPath + path.sep) && full !== repo.repoPath) {
        throw new Error(`Path traversal blocked: ${filePath}`);
      }
      return full;
    };

    // Step 1: Find the target symbol (reuse context's lookup)
    const lookupResult = await this.context(repo, {
      name: params.symbol_name,
      uid: params.symbol_uid,
      file_path,
    });

    if (lookupResult.status === 'ambiguous') {
      return lookupResult; // pass disambiguation through
    }
    if (lookupResult.error) {
      return lookupResult;
    }

    const sym = lookupResult.symbol;
    const oldName = sym.name;

    if (oldName === new_name) {
      return { error: 'New name is the same as the current name.' };
    }

    // Step 2: Collect edits from graph (high confidence)
    const changes = new Map<string, { file_path: string; edits: any[] }>();

    const addEdit = (
      filePath: string,
      line: number,
      oldText: string,
      newText: string,
      confidence: string,
    ) => {
      if (!changes.has(filePath)) {
        changes.set(filePath, { file_path: filePath, edits: [] });
      }
      changes.get(filePath)!.edits.push({ line, old_text: oldText, new_text: newText, confidence });
    };

    // The definition itself
    if (sym.filePath && sym.startLine) {
      try {
        const content = await fs.readFile(assertSafePath(sym.filePath), 'utf-8');
        const lines = content.split('\n');
        const lineIdx = sym.startLine - 1;
        if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx].includes(oldName)) {
          const defRegex = new RegExp(
            `\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            'g',
          );
          addEdit(
            sym.filePath,
            sym.startLine,
            lines[lineIdx].trim(),
            lines[lineIdx].replace(defRegex, new_name).trim(),
            'graph',
          );
        }
      } catch (e) {
        logQueryError('rename:read-definition', e);
      }
    }

    // All incoming refs from graph (callers, importers, etc.)
    const allIncoming = [
      ...(lookupResult.incoming.calls || []),
      ...(lookupResult.incoming.imports || []),
      ...(lookupResult.incoming.extends || []),
      ...(lookupResult.incoming.implements || []),
    ];

    let graphEdits = changes.size > 0 ? 1 : 0; // count definition edit

    for (const ref of allIncoming) {
      if (!ref.filePath) continue;
      try {
        const content = await fs.readFile(assertSafePath(ref.filePath), 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(oldName)) {
            addEdit(
              ref.filePath,
              i + 1,
              lines[i].trim(),
              lines[i]
                .replace(
                  new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
                  new_name,
                )
                .trim(),
              'graph',
            );
            graphEdits++;
            break; // one edit per file from graph refs
          }
        }
      } catch (e) {
        logQueryError('rename:read-ref', e);
      }
    }

    // Step 3: Text search for refs the graph might have missed
    let astSearchEdits = 0;
    const graphFiles = new Set(
      [sym.filePath, ...allIncoming.map((r) => r.filePath)].filter(Boolean),
    );

    // Simple text search across the repo for the old name (in files not already covered by graph)
    try {
      const { execFileSync } = await import('child_process');
      const rgArgs = [
        '-l',
        '--type-add',
        'code:*.{ts,tsx,js,jsx,py,go,rs,java,c,h,cpp,cc,cxx,hpp,hxx,hh,cs,php,swift}',
        '-t',
        'code',
        `\\b${oldName}\\b`,
        '.',
      ];
      const output = execFileSync('rg', rgArgs, {
        cwd: repo.repoPath,
        encoding: 'utf-8',
        timeout: 5000,
        // Avoid ENOBUFS on large repos: rg -l can list many files.
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
      });
      const files = output
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);

      for (const file of files) {
        const normalizedFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
        if (graphFiles.has(normalizedFile)) continue; // already covered by graph

        try {
          const content = await fs.readFile(assertSafePath(normalizedFile), 'utf-8');
          const lines = content.split('\n');
          const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              regex.lastIndex = 0;
              addEdit(
                normalizedFile,
                i + 1,
                lines[i].trim(),
                lines[i].replace(regex, new_name).trim(),
                'text_search',
              );
              astSearchEdits++;
            }
          }
        } catch (e) {
          logQueryError('rename:text-search-read', e);
        }
      }
    } catch (e) {
      logQueryError('rename:ripgrep', e);
    }

    // Step 4: Apply or preview
    const allChanges = Array.from(changes.values());
    const totalEdits = allChanges.reduce((sum, c) => sum + c.edits.length, 0);

    const failedFiles: string[] = [];
    if (!dry_run) {
      // Apply edits to files
      for (const change of allChanges) {
        try {
          const fullPath = assertSafePath(change.file_path);
          let content = await fs.readFile(fullPath, 'utf-8');
          const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          content = content.replace(regex, new_name);
          await fs.writeFile(fullPath, content, 'utf-8');
        } catch (e) {
          // A swallowed write failure must not be reported as a full success
          // (#2283): record the file so the result can degrade to 'partial'
          // with the unwritten files listed, rather than masquerading as done.
          logQueryError('rename:apply-edit', e);
          failedFiles.push(change.file_path);
        }
      }
    }

    return {
      status: failedFiles.length > 0 ? 'partial' : 'success',
      old_name: oldName,
      new_name,
      files_affected: allChanges.length,
      total_edits: totalEdits,
      graph_edits: graphEdits,
      text_search_edits: astSearchEdits,
      changes: allChanges,
      applied: !dry_run,
      ...(failedFiles.length > 0 && { failed_files: failedFiles }),
    };
  }

  private async trace(repo: RepoHandle, params: TraceParams): Promise<any> {
    try {
      return await this._traceImpl(repo, params);
    } catch (err: any) {
      return {
        status: 'error',
        error: (err instanceof Error ? err.message : String(err)) || 'Trace analysis failed',
        from: { name: params.from },
        to: { name: params.to },
        suggestion:
          'The graph query failed — try gitnexus context <symbol> to see connections, ' +
          'or check if an interface bridges them.',
        ...(isWalCorruptionError(err) ? { recoverySuggestion: WAL_RECOVERY_SUGGESTION } : {}),
      };
    }
  }

  private async _traceImpl(repo: RepoHandle, params: TraceParams): Promise<any> {
    await this.ensureInitialized(repo);

    // resolveSymbolCandidates feeds `from`/`to` into string operations
    // (e.g. name.includes), so a non-string param would surface a low-level
    // "x.includes is not a function". Reject it with a clear message instead.
    const isStringOrAbsent = (v: unknown): boolean => v === undefined || typeof v === 'string';
    if (
      !isStringOrAbsent(params.from) ||
      !isStringOrAbsent(params.to) ||
      !isStringOrAbsent(params.from_uid) ||
      !isStringOrAbsent(params.to_uid)
    ) {
      return {
        status: 'error',
        error: "'from', 'to', and their *_uid variants must be strings.",
        suggestion: 'Pass symbol names or UIDs as strings, e.g. trace from="A" to="B".',
      };
    }

    // A single-repo trace needs a target. Omitting `to` is the destination-trace
    // shorthand, but that only exists for a cross-repo @group trace — reject a
    // to-less single-repo call with an actionable error rather than the opaque
    // "Target symbol 'undefined' not found".
    const hasTo =
      (typeof params.to === 'string' && params.to.trim() !== '') ||
      (typeof params.to_uid === 'string' && params.to_uid.trim() !== '');
    if (!hasTo) {
      return {
        status: 'error',
        error: 'trace requires `to` (or `to_uid`) for a single-repo trace.',
        suggestion:
          'Pass a target symbol, or use repo:"@<group>" and omit `to` to trace `from` to its HTTP destination.',
      };
    }

    const fromOutcome = await this.resolveSymbolCandidates(
      repo,
      { uid: params.from_uid, name: params.from },
      { file_path: params.from_file },
    );

    if (fromOutcome.kind === 'not_found') {
      return {
        status: 'not_found',
        error: `Source symbol '${params.from_uid ?? params.from}' not found.`,
        suggestion: 'Check the symbol name or use --from-uid for zero-ambiguity.',
      };
    }
    if (fromOutcome.kind === 'ambiguous') {
      return {
        status: 'ambiguous',
        role: 'from',
        message: `Found ${fromOutcome.candidates.length} symbols matching '${params.from}'. Disambiguate with --from-uid.`,
        candidates: fromOutcome.candidates,
      };
    }

    const toOutcome = await this.resolveSymbolCandidates(
      repo,
      { uid: params.to_uid, name: params.to },
      { file_path: params.to_file },
    );

    if (toOutcome.kind === 'not_found') {
      return {
        status: 'not_found',
        error: `Target symbol '${params.to_uid ?? params.to}' not found.`,
        suggestion: 'Check the symbol name or use --to-uid for zero-ambiguity.',
      };
    }
    if (toOutcome.kind === 'ambiguous') {
      return {
        status: 'ambiguous',
        role: 'to',
        message: `Found ${toOutcome.candidates.length} symbols matching '${params.to}'. Disambiguate with --to-uid.`,
        candidates: toOutcome.candidates,
      };
    }

    const fromSym = fromOutcome.symbol;
    const toSym = toOutcome.symbol;

    if (fromSym.id === toSym.id) {
      return {
        status: 'ok',
        from: { name: fromSym.name, filePath: fromSym.filePath, startLine: fromSym.startLine },
        to: { name: toSym.name, filePath: toSym.filePath, startLine: toSym.startLine },
        hopCount: 0,
        hops: [{ name: fromSym.name, filePath: fromSym.filePath, startLine: fromSym.startLine }],
        edges: [],
      };
    }

    // Sanitize maxDepth at the real boundary: the MCP inputSchema's
    // minimum/maximum is advisory only (callTool is reachable directly), so a
    // caller can pass 0, a negative, NaN, or a non-integer. `??` does NOT
    // recover 0/NaN, and Math.min has no lower bound — left unguarded, any of
    // those makes the BFS loop run zero iterations and return a false no_path.
    const DEFAULT_TRACE_DEPTH = 10;
    const MAX_TRACE_DEPTH = 30;
    const requestedDepth =
      Number.isInteger(params.maxDepth) && (params.maxDepth as number) > 0
        ? (params.maxDepth as number)
        : DEFAULT_TRACE_DEPTH;
    const maxDepth = Math.min(requestedDepth, MAX_TRACE_DEPTH);
    const includeTests = params.includeTests ?? false;
    // Traversal vocabulary: CALLS for actual calls, HAS_METHOD so a class-rooted
    // trace can descend into its methods. Not "calls only" — per-hop edge type is
    // surfaced in edges[] so containment hops stay distinguishable.
    const TRAVERSAL_EDGE_TYPES = ['CALLS', 'HAS_METHOD'];

    // Bound the traversal so a high-fanout hub (a logger/util reached by many
    // symbols) can't materialize an unbounded frontier. Per-level rows are
    // capped and the total visited set is capped; either cap sets `truncated`
    // so a resulting no_path is never reported as if the graph was exhausted.
    const PER_NODE_FANOUT_CAP = 200;
    const ABS_ROW_CAP = 5000;
    const MAX_VISITED = 50000;
    let truncated = false;

    const visited = new Set<string>([fromSym.id]);
    let frontier = [fromSym.id];
    const parent = new Map<
      string,
      {
        from: string;
        name: string;
        filePath: string;
        startLine: number;
        edgeType: string;
        confidence: number;
      }
    >();

    let found = false;
    // The last node discovered at the deepest reached level — surfaced as
    // `furthest` in the no_path response to hint where the chain breaks.
    let lastReached: {
      name: string;
      filePath: string;
      startLine: number;
    } | null = null;
    let reachedDepth = 0;

    for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !found; depth++) {
      const nextFrontier: string[] = [];
      // LadybugDB/Kuzu does not support a parameterized LIMIT, so the cap is
      // interpolated (it is a derived integer, not user input).
      const rowCap = Math.min(frontier.length * PER_NODE_FANOUT_CAP, ABS_ROW_CAP);

      const rows = await executeParameterized(
        repo.lbugPath,
        `MATCH (n)-[r:CodeRelation]->(m)
         WHERE n.id IN $frontierIds AND r.type IN $edgeTypes
         RETURN n.id AS sourceId, m.id AS id, m.name AS name, labels(m)[0] AS type,
                m.filePath AS filePath, m.startLine AS startLine,
                r.type AS edgeType, r.confidence AS confidence
         LIMIT ${rowCap}`,
        { frontierIds: frontier, edgeTypes: TRAVERSAL_EDGE_TYPES },
      );

      // A clipped level may have dropped a node that lies on the only shortest
      // path, so any subsequent no_path is not authoritative.
      if (rows.length >= rowCap) truncated = true;

      for (const row of rows) {
        // Decode once. The `?? row[N]` fallback handles LadybugDB tuple-mode
        // returns; the positional indices mirror the RETURN column order above.
        const nodeId = (row.id ?? row[1]) as string;
        const sourceId = (row.sourceId ?? row[0]) as string;
        const name = (row.name ?? row[2]) as string;
        const filePath = (row.filePath ?? row[4]) as string;
        const startLine = (row.startLine ?? row[5]) as number;
        const edgeType = (row.edgeType ?? row[6]) as string;
        const storedConfidence = row.confidence ?? row[7];
        const confidence =
          typeof storedConfidence === 'number' && storedConfidence > 0
            ? storedConfidence
            : confidenceForRelType(edgeType);

        // Match the explicitly-requested target before the test-file filter.
        // resolveSymbolCandidates does not exclude test-file symbols, so a
        // target (or a required hop) that lives in a test file would otherwise
        // be dropped by the includeTests guard below and produce a false
        // no_path even when a direct edge exists.
        if (nodeId === toSym.id) {
          parent.set(nodeId, { from: sourceId, name, filePath, startLine, edgeType, confidence });
          found = true;
          break;
        }

        // Skip non-target nodes that live in test files unless includeTests.
        if (!includeTests && isTestFilePath(filePath)) continue;

        if (!visited.has(nodeId)) {
          visited.add(nodeId);
          parent.set(nodeId, { from: sourceId, name, filePath, startLine, edgeType, confidence });
          nextFrontier.push(nodeId);
          lastReached = { name, filePath, startLine };
          reachedDepth = depth;
        }
      }

      frontier = nextFrontier;
      if (visited.size >= MAX_VISITED) {
        truncated = true;
        break;
      }
    }

    if (found) {
      const path: Array<{ name: string; filePath: string; startLine: number }> = [];
      const edges: Array<{ relType: string; confidence: number }> = [];
      let current = toSym.id;

      while (current !== fromSym.id) {
        const info = parent.get(current)!;
        path.unshift({ name: info.name, filePath: info.filePath, startLine: info.startLine });
        edges.unshift({ relType: info.edgeType, confidence: info.confidence });
        current = info.from;
      }
      path.unshift({
        name: fromSym.name,
        filePath: fromSym.filePath,
        startLine: fromSym.startLine,
      });

      return {
        status: 'ok',
        from: { name: fromSym.name, filePath: fromSym.filePath, startLine: fromSym.startLine },
        to: { name: toSym.name, filePath: toSym.filePath, startLine: toSym.startLine },
        hopCount: edges.length,
        hops: path,
        edges,
      };
    }

    return {
      status: 'no_path',
      from: { name: fromSym.name, filePath: fromSym.filePath, startLine: fromSym.startLine },
      to: { name: toSym.name, filePath: toSym.filePath, startLine: toSym.startLine },
      furthest: lastReached ? { ...lastReached, depth: reachedDepth } : null,
      ...(truncated ? { truncated: true } : {}),
      suggestion: truncated
        ? 'Search was truncated at a traversal cap before exhausting the graph — a path ' +
          'may still exist. Narrow the search (a lower --depth, or trace from a more ' +
          'specific symbol), or use gitnexus context <symbol> to inspect connections.'
        : 'No directed path found. The call chain likely breaks at dynamic dispatch, ' +
          'reflection, or an external API boundary. Try gitnexus context <symbol> to see ' +
          "both symbols' connections, or check if an interface/abstraction bridges them.",
    };
  }

  private async impact(repo: RepoHandle, params: ImpactParams): Promise<any> {
    try {
      return await this._impactImpl(repo, params);
    } catch (err: any) {
      // Return structured error instead of crashing (#321)
      const message =
        (err instanceof Error ? err.message : String(err)) || 'Impact analysis failed';
      const suggestion = 'The graph query failed — try gitnexus context <symbol> as a fallback';
      const recoverySuggestion = isWalCorruptionError(err) ? WAL_RECOVERY_SUGGESTION : undefined;
      if (params.mode === 'pdg') {
        // Symbol resolution never reached the catch with a resolved symbol (the
        // throw can originate before/within resolution), so the envelope carries
        // the partial-but-typed target — typed as PdgImpactTarget so the partial
        // is type-checked, not an inline literal in a Promise<any> hole.
        const target: PdgImpactTarget = { name: params.target };
        const pdgErr: PdgImpactErrorResult = makePdgImpactErrorResult({
          mode: 'pdg',
          error: message,
          target,
          direction: params.direction,
          suggestion,
          recoverySuggestion,
        });
        return pdgErr;
      }
      return {
        error: message,
        target: { name: params.target },
        direction: params.direction,
        impactedCount: 0,
        risk: 'UNKNOWN',
        suggestion,
        ...(recoverySuggestion ? { recoverySuggestion } : {}),
      };
    }
  }

  private async _impactImpl(repo: RepoHandle, params: ImpactParams): Promise<any> {
    await this.ensureInitialized(repo);

    const { target, direction } = params;

    // ── Dispatch order (KTD5) ──────────────────────────────────────────
    // (1) Validate `mode`. Absent/'callgraph' → unchanged path; 'pdg' → the
    // intra-procedural PDG engine; anything else → hard error.
    // This MUST come before resolveSymbolCandidates so the ambiguous branch can
    // fork on the validated mode and never run the callgraph fan-out under pdg.
    const modeResult = validateImpactMode(params.mode);
    if ('error' in modeResult) {
      return {
        error: modeResult.error,
        target: { name: target },
        direction,
        impactedCount: 0,
        risk: 'UNKNOWN',
      };
    }
    const mode = modeResult.mode;

    // #2279: some MCP client/agent adapters serialize an *omitted* optional
    // numeric field as `0` rather than dropping it, so callgraph calls arrive
    // carrying a spurious `line: 0`. `line` is meaningless on the callgraph path
    // (the symbol→symbol BFS has no statement notion), so treat a literal `0`
    // there as omitted and let the normal traversal run. The coercion is
    // deliberately narrow — only the literal `0`, only when mode !== 'pdg':
    // a genuine positive `line` on callgraph still errors (real mode mistake),
    // negative/fractional values still error, and pdg mode is untouched (the
    // normalization is an identity there, so `line: 0` is still rejected below —
    // there is no 1-based source line `0` to anchor on).
    const effectiveLine = mode !== 'pdg' && params.line === 0 ? undefined : params.line;

    // `line` is a PDG-only statement anchor. Reject it on the callgraph path
    // rather than silently ignore (the symbol→symbol BFS has no statement notion).
    if (effectiveLine !== undefined && mode !== 'pdg') {
      return {
        error: `Parameter 'line' is only supported with mode:'pdg' (it anchors the dependence slice on a statement). Remove it or set mode:'pdg'.`,
        target: { name: params.target },
        direction: params.direction,
        impactedCount: 0,
        risk: 'UNKNOWN',
      };
    }
    // A provided `line` must be a positive integer.
    if (
      effectiveLine !== undefined &&
      (!Number.isInteger(effectiveLine) || (effectiveLine as number) < 1)
    ) {
      // Line param fails validation before target resolution → partial-but-typed
      // target on the pdg path (typed PdgImpactTarget, not an inline literal).
      const badLineTarget: PdgImpactTarget = { name: params.target };
      return mode === 'pdg'
        ? makePdgImpactErrorResult({
            mode: 'pdg',
            error: `Parameter 'line' must be a positive integer (1-based source line), got ${JSON.stringify(params.line)}.`,
            target: badLineTarget,
            direction: params.direction,
          })
        : {
            error: `Parameter 'line' must be a positive integer (1-based source line), got ${JSON.stringify(params.line)}.`,
            target: { name: params.target },
            direction: params.direction,
            impactedCount: 0,
            risk: 'UNKNOWN',
          };
    }

    if (mode === 'pdg') {
      // PDG mode is now unified inside a single repo: it combines the local
      // CDG/RD statement slice with the same inter-symbol reach used for the
      // option-driven comparison path. Cross-repo fan-out remains a callgraph
      // feature, so crossDepth is still a loud error rather than a silent ignore.
      const incompatible: string[] = [];
      if (params.crossDepth !== undefined) incompatible.push('crossDepth');
      if (incompatible.length > 0) {
        // crossDepth is rejected before target resolution → partial-but-typed
        // target (typed PdgImpactTarget).
        const crossDepthTarget: PdgImpactTarget = { name: target };
        const pdgErr: PdgImpactErrorResult = makePdgImpactErrorResult({
          mode: 'pdg',
          error:
            `Parameter(s) ${incompatible.join(', ')} are not supported with mode:'pdg' ` +
            `(single-repo PDG impact). Remove them or use mode:'callgraph' for cross-repo fan-out.`,
          target: crossDepthTarget,
          direction,
        });
        return pdgErr;
      }
    }

    const maxDepth = params.maxDepth || 3;
    // Map legacy relation type names before filtering (backward compat for OVERRIDES → METHOD_OVERRIDES)
    const mappedRelTypes = params.relationTypes?.flatMap((t: string) =>
      t === 'OVERRIDES' ? ['OVERRIDES', 'METHOD_OVERRIDES'] : [t],
    );
    const hasExplicitRelationTypes = mappedRelTypes !== undefined && mappedRelTypes.length > 0;
    const rawRelTypes =
      mappedRelTypes && mappedRelTypes.length > 0
        ? mappedRelTypes.filter((t: string) => VALID_RELATION_TYPES.has(t))
        : [
            'CALLS',
            'IMPORTS',
            'EXTENDS',
            'IMPLEMENTS',
            'USES',
            'METHOD_OVERRIDES',
            'OVERRIDES',
            'METHOD_IMPLEMENTS',
          ];
    const relationTypes =
      rawRelTypes.length > 0
        ? rawRelTypes
        : [
            'CALLS',
            'IMPORTS',
            'EXTENDS',
            'IMPLEMENTS',
            'USES',
            'METHOD_OVERRIDES',
            'OVERRIDES',
            'METHOD_IMPLEMENTS',
          ];
    const includeTests = params.includeTests ?? false;
    const minConfidence = params.minConfidence ?? 0;

    // Resolve target via the shared symbol resolver. When the caller passes
    // target_uid we skip the name lookup entirely (zero-ambiguity). Otherwise
    // we rank candidates (#470) and either proceed with a confident single
    // match, or return a structured ambiguous response instead of silently
    // picking the wrong symbol.
    //
    // The resolver preserves the #480 Class/Constructor preference heuristic:
    // when a Class and its Constructor share name + filePath, the Class is
    // selected silently.
    const outcome = await this.resolveSymbolCandidates(
      repo,
      { uid: params.target_uid, name: target },
      { file_path: params.file_path, kind: params.kind },
    );

    if (outcome.kind === 'not_found') {
      const missing = params.target_uid ?? target;
      // not_found = no resolved symbol, so the envelope keeps the partial-but-
      // typed target (typed PdgImpactTarget — there is no id/type/filePath yet).
      const notFoundTarget: PdgImpactTarget = { name: target };
      return mode === 'pdg'
        ? makePdgImpactErrorResult({
            mode: 'pdg',
            error: `Target '${missing}' not found`,
            target: notFoundTarget,
            direction,
          })
        : {
            error: `Target '${missing}' not found`,
            target: { name: target },
            direction,
            impactedCount: 0,
            risk: 'UNKNOWN',
          };
    }

    if (outcome.kind === 'ambiguous') {
      // Shared truncation cap for the ambiguous candidate list — both the pdg
      // branch (shows candidates) and the callgraph branch (probes candidates)
      // bound to this many.
      const AMBIGUOUS_MAX_CANDIDATES = 6;
      // KTD5 ambiguous trap — under mode:'pdg' we MUST NOT fall into the
      // callgraph fan-out below: it runs `_runImpactBFS` per candidate, which
      // would silently execute the call-graph engine under a `pdg` call (the
      // exact silent fallback KTD5 forbids). For U1 the pdg ambiguous path
      // returns the candidate list WITHOUT any callgraph probe; the full pdg
      // ambiguous handling (per-candidate PDG summaries / ranking) lands in U4.
      if (mode === 'pdg') {
        const truncated = outcome.candidates.length > AMBIGUOUS_MAX_CANDIDATES;
        const shown = outcome.candidates.slice(0, AMBIGUOUS_MAX_CANDIDATES);
        return {
          status: 'ambiguous',
          mode,
          message:
            `Found ${outcome.candidates.length} symbols matching '${target}'` +
            (truncated ? ` (showing ${shown.length} of ${outcome.candidates.length})` : '') +
            `. Disambiguate with target_uid (or file_path/kind) for a single ` +
            `authoritative PDG result.`,
          target: { name: target },
          direction,
          totalCandidates: outcome.candidates.length,
          // No single resolved symbol → impactedCount stays 0 / risk UNKNOWN
          // (UNKNOWN must never read as "safe to refactor"). No callgraph
          // fan-out runs, so there is no per-candidate blast radius here yet.
          impactedCount: 0,
          risk: 'UNKNOWN',
          ...(truncated && { candidatesTruncated: true }),
          candidates: shown.map((c) => ({
            uid: c.id,
            name: c.name,
            kind: c.type,
            filePath: c.filePath,
            line: toDisplayLine(c.startLine),
            score: Number(c.score.toFixed(2)),
          })),
        };
      }

      // #2129 — a bare name that collides with several symbols must NOT report a
      // bare `impactedCount: 0`. The real blast radius lives under whichever
      // candidate the caller meant; a flat zero here is precisely the silent
      // under-report the "run impact before editing" workflow exists to prevent
      // (the dropped caller calls a *different* same-name node, so it never shows
      // up against the one the resolver happened to pick). Run a bounded,
      // summary-only BFS per candidate so each one's true count + risk is
      // visible, and surface the maximum at the top level so the headline can
      // never read as "safe to refactor". Candidates arrive sorted by score.
      const probed = outcome.candidates.slice(0, AMBIGUOUS_MAX_CANDIDATES);
      // `partialProbe` is intentionally a SECOND incompleteness flag, distinct
      // from the traversal-interrupted `partial` flag used elsewhere: it means
      // one or more per-candidate probes threw, so maxRisk / maxImpactedCount
      // are lower bounds over the probes that succeeded (a failed candidate must
      // not be masked by a benign sibling success).
      let probeFailed = false;
      const candidateSummaries = await Promise.all(
        probed.map(async (c) => {
          const cType = c.type || '';
          const cRelTypes =
            (cType === 'Class' || cType === 'Interface') &&
            !hasExplicitRelationTypes &&
            !relationTypes.includes('ACCESSES')
              ? [...relationTypes, 'ACCESSES']
              : relationTypes;
          // #1858/#2129 review F8 — name the shape the probe summary is read
          // through (`_runImpactBFS` returns `Promise<any>`, so this is the
          // narrowing cast) so a future rename of those fields fails tsc instead
          // of silently zeroing candidate counts.
          let summary: {
            impactedCount: number;
            risk: string;
            summary?: { direct: number };
          } | null = null;
          try {
            summary = await this._runImpactBFS(
              repo,
              { id: c.id, name: c.name, filePath: c.filePath },
              cType,
              direction,
              {
                maxDepth,
                relationTypes: cRelTypes,
                includeTests,
                minConfidence,
                summaryOnly: true,
                skipEpistemic: true,
                skipEnrichment: true,
              },
            );
          } catch (e) {
            probeFailed = true;
            logQueryError('impact:ambiguous-candidate', e);
          }
          return {
            uid: c.id,
            name: c.name,
            kind: c.type,
            filePath: c.filePath,
            line: toDisplayLine(c.startLine),
            score: Number(c.score.toFixed(2)),
            impactedCount: summary?.impactedCount ?? 0,
            risk: summary?.risk ?? 'UNKNOWN',
            direct: summary?.summary?.direct ?? 0,
          };
        }),
      );

      // Rank by blast radius so the most-impactful interpretation is first, and
      // hoist the maximum count/risk to the top level so the response cannot be
      // misread as "no impact".
      candidateSummaries.sort((a, b) => b.impactedCount - a.impactedCount);
      const maxImpactedCount = candidateSummaries.reduce((m, c) => Math.max(m, c.impactedCount), 0);
      const RISK_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      // If EVERY candidate probe failed (all 'UNKNOWN' — e.g. pool exhaustion
      // under the fan-out), the worst real risk is genuinely unknown, not LOW.
      // Reporting LOW here would re-introduce the false-safe signal. Only fall to
      // the LOW seed when at least one candidate produced a real risk.
      const anyKnownRisk = candidateSummaries.some((c) => RISK_ORDER.includes(c.risk));
      const maxRisk = anyKnownRisk
        ? candidateSummaries.reduce(
            (worst, c) => (RISK_ORDER.indexOf(c.risk) > RISK_ORDER.indexOf(worst) ? c.risk : worst),
            'LOW',
          )
        : 'UNKNOWN';
      const truncated = outcome.candidates.length > probed.length;

      return {
        status: 'ambiguous',
        message:
          `Found ${outcome.candidates.length} symbols matching '${target}'` +
          (truncated
            ? ` (showing ${candidateSummaries.length} of ${outcome.candidates.length})`
            : '') +
          `. Blast radius differs per candidate (max ${maxImpactedCount} impacted at risk ${maxRisk}). ` +
          `Disambiguate with target_uid (or file_path/kind) for a single authoritative result.`,
        target: { name: target },
        direction,
        // Full match count — `candidates[]` is truncated to AMBIGUOUS_MAX_CANDIDATES,
        // so consumers (CLI formatter) need this to report "N of M" honestly (#2129
        // review F11; the CLI previously read the truncated array length).
        totalCandidates: outcome.candidates.length,
        // `impactedCount` stays 0 and `risk` stays UNKNOWN — there is no single
        // resolved symbol, and UNKNOWN must NOT read as "safe to refactor". The
        // real blast radius is surfaced per-candidate plus `maxImpactedCount` /
        // `maxRisk` so a real caller can never hide behind the ambiguous zero
        // (#2129).
        impactedCount: 0,
        risk: 'UNKNOWN',
        maxImpactedCount,
        maxRisk,
        ...(probeFailed ? { partialProbe: true } : {}),
        ...(truncated && { candidatesTruncated: true }),
        candidates: candidateSummaries,
      };
    }

    const sym = {
      id: outcome.symbol.id,
      name: outcome.symbol.name,
      filePath: outcome.symbol.filePath,
      // Carry the resolved span so the PDG seed anchors on THIS symbol directly,
      // without re-resolving its (possibly ambiguous) name (FIX 1).
      startLine: outcome.symbol.startLine,
      endLine: outcome.symbol.endLine,
    };
    const symType = outcome.resolvedLabel || outcome.symbol.type || '';

    // (2) PDG-layer presence probe (U2, KTD7) — the four-state degradation
    // contract after target resolution, before traversal. A repo never analyzed
    // with `--pdg` (no-layer), one with only a partial layer (sub-layer-missing
    // — impact needs BOTH CDG and REACHING_DEF), or one whose meta is unreadable
    // (unknown) each returns a distinct guidance note here rather than a
    // confusing empty blast radius. Resolve first so target-known degraded
    // responses keep the same id/type/filePath envelope as successful PDG
    // responses; only `ready` falls through to traversal.
    // Hoisted so the (4) traversal branch can read `layer.hasCallSummary` (FU-C):
    // the same single meta-stamp probe serves both the degradation gate and the
    // ascent-availability note — no second probe.
    let layer: PdgLayerStatus | undefined;
    if (mode === 'pdg') {
      layer = await pdgLayerStatus({
        lbugPath: repo.lbugPath,
        executeParameterized,
      });
      if (isPdgDegradedLayerStatus(layer)) {
        // Degradation occurs AFTER target resolution → thread the FULL typed
        // envelope ({ id, name, type, filePath }) so degraded responses keep the
        // same target shape as a successful PDG result (typed PdgImpactTarget).
        const degradedTarget: PdgImpactTarget = {
          id: sym.id,
          name: sym.name,
          type: symType || 'Function',
          filePath: sym.filePath,
        };
        return makePdgLayerDegradedResult({
          mode,
          layer,
          target: degradedTarget,
          direction,
        });
      }
    }

    const effectiveRelationTypes =
      (symType === 'Class' || symType === 'Interface') &&
      !hasExplicitRelationTypes &&
      !relationTypes.includes('ACCESSES')
        ? [...relationTypes, 'ACCESSES']
        : relationTypes;

    // (4) single → route the resolved symbol to the engine selected by `mode`.
    if (mode === 'pdg') {
      const pdgResult = await this._runImpactPDG({
        repo,
        sym,
        symType,
        direction,
        maxDepth,
        // Use the normalized line, not raw params.line, so the gate and the
        // engine share one source of truth (#2283). Identity in pdg mode today
        // — effectiveLine === params.line when mode === 'pdg' — but this stays
        // correct if the normalization ever stops being an identity here.
        line: effectiveLine,
        limit: Number.isFinite(params.limit) ? params.limit : 100,
        // KTD2 extraction-seam discipline: hand the engine its DB dependency
        // explicitly rather than `this.`-binding it. LocalBackend owns repo
        // lifecycle; `pdg-impact.ts` owns traversal/projection.
        executeParameterized,
        // FU-C: thread the CALL_SUMMARY layer presence read above (meta stamp) so
        // the engine notes "no return-value ascent (re-index)" on a pre-FU-C (v3)
        // index. `layer.hasCallSummary` is set on every meta-readable state.
        callSummaryAvailable: layer?.hasCallSummary === true,
      });

      // Statement-precise inter-procedural reach: a first-hop callee is "proven"
      // iff it is invoked in a block of the criterion's dependence slice. The
      // slice = the seed block(s) (the changed line itself) UNION the dependent
      // reachable blocks — both carry the leaf callee names they call
      // (`BasicBlock.callees`). The seed block is included because a callee
      // invoked directly on the changed line is the most-directly-impacted one,
      // yet `reachableBlocks` excludes the seed by the seed-minus-reachable
      // convention. Upstream seeds carry no discriminating slice, so the bridge
      // falls back to preserving callgraph reach.
      // `_runImpactPDG` returns the PdgImpactResult union; only the success/empty
      // slice results carry intraReachableBlocks/seedBlocks (degraded and error
      // results do not). Narrow via the same discriminant the composer uses, then
      // read the typed string[] slices — no `as any`.
      const sliceResult = 'error' in pdgResult || 'pdgLayer' in pdgResult ? null : pdgResult;
      // FIX 6: key the "first-hop proven" set on the INTRA-procedural slice only
      // (seed ∪ intra-reachable), NOT `reachableBlocks` — which the U1 descent now
      // EXPANDS with inter-procedurally-reached callee blocks. Using the expanded
      // superset would mark transitively-reached (2+ hop) callgraph targets as
      // first-hop "proven", silently shifting the established statementPrecision
      // semantics. The interproc-reached blocks are routed into the statement
      // slice / block→symbol projection inside `_runImpactPDG` only.
      const intraReachableBlocks: string[] = sliceResult?.intraReachableBlocks ?? [];
      const seedBlocks: string[] = sliceResult?.seedBlocks ?? [];
      const sliceBlocks = [...seedBlocks, ...intraReachableBlocks];
      const sliceCalleeNames =
        direction === 'downstream' && sliceBlocks.length > 0
          ? await this.calleesOfBlocks(repo, sliceBlocks)
          : new Set<string>();
      // Resolved-id slice set (sound primary key, KTD3): unioned from the SAME
      // seed ∪ reachable block set as the names — so a callee invoked only on the
      // seeded line is still provable by id. Absent on a pre-v3 index (no
      // `calleeIds` column) → empty → the bridge falls back to the leaf-name match.
      const sliceCalleeIds =
        direction === 'downstream' && sliceBlocks.length > 0
          ? await this.calleeIdsOfBlocks(repo, sliceBlocks)
          : new Set<string>();
      // Build the bridge when EITHER the name fallback or the id key has signal —
      // an id-only index (names empty but ids present) must still seed the bridge.
      const pdgBridge: PdgBridgeOptions | undefined =
        sliceCalleeNames.size > 0 || sliceCalleeIds.size > 0
          ? { sliceCalleeNames, sliceCalleeIds }
          : undefined;

      try {
        const interproceduralResult = await this._runImpactBFS(repo, sym, symType, direction, {
          maxDepth,
          relationTypes: effectiveRelationTypes,
          includeTests,
          minConfidence,
          limit: Number.isFinite(params.limit) ? params.limit : 100,
          offset: Number.isFinite(params.offset) ? params.offset : 0,
          pdgBridge,
        });
        return composeUnifiedPdgImpactResult(pdgResult, interproceduralResult);
      } catch (e) {
        logQueryError('impact:pdg-interprocedural-reach', e);
        return composeUnifiedPdgImpactResult(pdgResult, null, e);
      }
    }

    return this._runImpactBFS(repo, sym, symType, direction, {
      maxDepth,
      relationTypes: effectiveRelationTypes,
      includeTests,
      minConfidence,
      limit: Number.isFinite(params.limit) ? params.limit : 100,
      offset: Number.isFinite(params.offset) ? params.offset : 0,
      summaryOnly: params.summaryOnly,
    });
  }

  /**
   * Union of the leaf callee names invoked across a set of dependence-slice
   * blocks (`BasicBlock.callees`, space-joined at emit). Drives statement-precise
   * inter-procedural evidence: a first-hop callee reached from the criterion is
   * "proven" (callgraph-bridge) iff its name is in this set, else unproven-bridge.
   * Empty when the slice blocks call nothing or carry no harvested callees
   * (non-TS/JS or synthetic ENTRY/EXIT blocks) — the bridge then preserves
   * callgraph reach. A query failure is logged and degrades to empty (no proof),
   * never throws (the inter-procedural reach is still returned).
   */
  private async calleesOfBlocks(repo: RepoHandle, blockIds: string[]): Promise<Set<string>> {
    const names = new Set<string>();
    if (blockIds.length === 0) return names;
    try {
      const rows = await executeParameterized(
        repo.lbugPath,
        `MATCH (b:BasicBlock) WHERE b.id IN $ids RETURN b.callees AS callees`,
        { ids: blockIds },
      );
      for (const r of rows as any[]) {
        const raw = String(r.callees ?? r[0] ?? '');
        for (const n of raw.split(' ')) if (n) names.add(n);
      }
    } catch (e) {
      logQueryError('impact:pdg-slice-callees', e);
    }
    return names;
  }

  /**
   * Union of the RESOLVED callee symbol ids invoked across a set of
   * dependence-slice blocks (`BasicBlock.calleeIds`, space-joined at emit —
   * sibling of `callees`). This is the SOUND key the bridge prefers: a first-hop
   * callee is proven statement-precise iff its resolved id is in this set, which
   * eliminates the same-leaf-name collision (false-positive) and import-alias
   * (false-negative) the name set cannot distinguish. Empty when the slice blocks
   * carry no captured ids (pre-v3 index without the `calleeIds` column, or
   * non-overloading/synthetic blocks) — the bridge then falls back to the
   * leaf-name match per U5. A query failure is logged and degrades to empty (no
   * proof), never throws (the inter-procedural reach is still returned). Mirrors
   * `calleesOfBlocks` exactly — same shape, same swallow-on-error contract.
   */
  private async calleeIdsOfBlocks(repo: RepoHandle, blockIds: string[]): Promise<Set<string>> {
    const ids = new Set<string>();
    if (blockIds.length === 0) return ids;
    try {
      const rows = await executeParameterized(
        repo.lbugPath,
        `MATCH (b:BasicBlock) WHERE b.id IN $ids RETURN b.calleeIds AS calleeIds`,
        { ids: blockIds },
      );
      for (const r of rows) {
        // Shared split-and-drop-sentinel logic (`splitCalleeIds`) so this bridge
        // key and the inter-procedural descent cannot diverge. The sentinel marks
        // a capped block (handled by the names-sentinel check in the bridge) and
        // is not a resolved symbol id, so it never enters the `has(realId)` set.
        for (const id of splitCalleeIds(r.calleeIds ?? r[0])) ids.add(id);
      }
    } catch (e) {
      logQueryError('impact:pdg-slice-callee-ids', e);
    }
    return ids;
  }

  /**
   * Delegates the PDG impact engine to `pdg-impact.ts`.
   *
   * The private method remains as the LocalBackend dispatch seam so existing
   * tests can keep asserting that `mode:'pdg'` routes through the PDG
   * statement engine before LocalBackend attaches interprocedural symbol reach.
   * The traversal/projection/result assembly lives in the extracted helper
   * module.
   */
  private async _runImpactPDG(deps: {
    repo: RepoHandle;
    sym: { id: string; name: string; filePath: string; startLine?: number; endLine?: number };
    symType: string;
    direction: 'upstream' | 'downstream';
    maxDepth: number;
    limit: number;
    line?: number;
    executeParameterized: typeof executeParameterized;
    callSummaryAvailable?: boolean;
  }): Promise<PdgImpactResult> {
    return runImpactPDG(deps);
  }

  /**
   * #1858 — epistemic lower-bound detection.
   *
   * impact()/context() traverse only edges materialized in the graph. When the
   * queried symbol sits on an interface / abstract boundary, callers that bind
   * to the interface via DI, a container, or dynamic dispatch — rather than
   * naming the concrete symbol — are not traced. The reported count is then a
   * lower bound, not an exact figure. Instead of returning a confident count
   * that silently omits those callers, annotate the result with
   * `epistemic: 'lower-bound'` plus a human-readable boundary note. A fully
   * resolved leaf with no indirection stays `epistemic: 'exact'`.
   *
   * Aligns with the numeric confidence model rather than the long-deleted
   * TIER_CONFIDENCE enum: the heritage/indirection edges this keys on
   * (IMPLEMENTS / METHOD_IMPLEMENTS / EXTENDS) carry the 0.85
   * `IMPACT_RELATION_CONFIDENCE` floor — "statically verifiable, but the
   * concrete binding past it is not".
   *
   * Never throws: on query error it returns 'exact', so it can only add signal,
   * never suppress a result.
   */
  private async computeEpistemicBoundary(
    repo: RepoHandle,
    symId: string,
    symType: string,
    symName: string,
  ): Promise<{ epistemic: 'exact' | 'lower-bound'; boundaries?: string[] }> {
    const HERITAGE_TYPES = EPISTEMIC_HERITAGE_RELATION_TYPES;
    const CONSUMER_TYPES = EPISTEMIC_CONSUMER_RELATION_TYPES;
    try {
      // Discover the interface / abstract supertypes on the target's boundary.
      // If the target is itself an interface, it is its own boundary node.
      const boundary = new Map<string, { name: string; label: string }>();
      if (symType === 'Interface') {
        boundary.set(symId, { name: symName || '', label: 'Interface' });
      }
      const ifaceRows = await executeParameterized(
        repo.lbugPath,
        `MATCH (x)-[r:CodeRelation]->(iface)
         WHERE x.id = $symId AND r.type IN $heritage
         RETURN DISTINCT iface.id AS id, iface.name AS name, labels(iface)[0] AS label
         LIMIT 25`,
        { symId, heritage: HERITAGE_TYPES },
      ).catch(() => []);
      for (const r of ifaceRows) {
        const id = (r.id ?? r[0]) as string;
        if (id && !boundary.has(id)) {
          boundary.set(id, {
            name: (r.name ?? r[1] ?? '') as string,
            label: (r.label ?? r[2] ?? 'Interface') as string,
          });
        }
      }
      if (boundary.size === 0) return { epistemic: 'exact' };

      const ifaceIds = Array.from(boundary.keys());
      // Count per interface id with scalar equality. A parameterized
      // `iface.id IN $ids` combined with `COUNT(DISTINCT ...)` + implicit
      // group-by returns no rows under the LadybugDB cypher subset, so query
      // each boundary node individually (boundary is small — capped at 25).
      const countByType = async (types: readonly string[]): Promise<Map<string, number>> => {
        const m = new Map<string, number>();
        await Promise.all(
          ifaceIds.map(async (ifaceId) => {
            const rows = await executeParameterized(
              repo.lbugPath,
              `MATCH (other)-[r:CodeRelation]->(iface)
               WHERE iface.id = $ifaceId AND r.type IN $types
               RETURN COUNT(DISTINCT other.id) AS cnt`,
              { ifaceId, types },
            ).catch(() => []);
            const cnt =
              rows.length > 0 ? Number((rows[0] as any).cnt ?? (rows[0] as any)[0] ?? 0) : 0;
            m.set(ifaceId, cnt);
          }),
        );
        return m;
      };
      const [implCounts, consumerCounts] = await Promise.all([
        countByType(HERITAGE_TYPES),
        countByType(CONSUMER_TYPES),
      ]);

      const boundaries: string[] = [];
      for (const [id, info] of boundary) {
        const impls = implCounts.get(id) ?? 0;
        const consumers = consumerCounts.get(id) ?? 0;
        // Flag only a genuine indirection risk: an interface that is actually
        // consumed (callers bind to it) or that has multiple implementations
        // (runtime dispatch is ambiguous). A concrete type implementing an
        // interface nothing references is fully traced → stays exact.
        if (consumers >= 1 || impls >= 2) {
          const label = (info.label || 'Interface').toLowerCase();
          const name = info.name || '(unnamed)';
          const article = /^[aeiou]/.test(label) ? 'an' : 'a';
          const parts: string[] = [];
          if (impls >= 1)
            parts.push(`${impls} ${impls === 1 ? 'implementation' : 'implementations'}`);
          if (consumers >= 1)
            parts.push(
              `${consumers} interface-level ${consumers === 1 ? 'consumer' : 'consumers'}`,
            );
          boundaries.push(
            `${name} is ${article} ${label} with ${parts.join(' and ')}; callers that bind via the ${label} ` +
              `(e.g. a DI container or dynamic dispatch) are not traced to the concrete symbol — ` +
              `actual impact may be higher.`,
          );
        }
      }
      if (boundaries.length === 0) return { epistemic: 'exact' };
      return { epistemic: 'lower-bound', boundaries };
    } catch {
      return { epistemic: 'exact' };
    }
  }

  /**
   * Shared BFS traversal for impact analysis (name-resolved or UID-resolved symbol).
   */
  private async _runImpactBFS(
    repo: RepoHandle,
    sym: any,
    symType: string,
    direction: 'upstream' | 'downstream',
    opts: {
      maxDepth: number;
      relationTypes: string[];
      includeTests: boolean;
      minConfidence: number;
      limit?: number;
      offset?: number;
      summaryOnly?: boolean;
      // Enrichment/annotation suppression flags (#1858/#2129 review F6). Each
      // suppresses a distinct sub-phase; they compose, and the real call sites are:
      //   - full impact()/context(): none set.
      //   - group cross-repo fan-out (impactByUid): skipPerSymbolEnrichment +
      //     skipEpistemic — the fan-out consumes only byDepth.
      //   - ambiguous #2129 per-candidate probe: skipEpistemic + skipEnrichment —
      //     needs only count + a count-based risk.
      // skipPerSymbolEnrichment: drop the post-pagination per-symbol
      //   STEP_IN_PROCESS pass (keeps byDepth).
      // skipEpistemic: skip the #1858 interface/indirection boundary probe.
      // skipEnrichment: skip the process/module aggregation passes entirely;
      //   risk then derives from directCount/total only. NOTE: this also makes
      //   skipPerSymbolEnrichment a no-op (affectedProcesses stays empty), which
      //   is why the ambiguous probe sets only the two flags above.
      skipPerSymbolEnrichment?: boolean;
      skipEpistemic?: boolean;
      skipEnrichment?: boolean;
      pdgBridge?: PdgBridgeOptions;
    },
  ): Promise<any> {
    const { maxDepth, relationTypes, includeTests, minConfidence } = opts;
    const skipPerSymbolEnrichment = opts.skipPerSymbolEnrichment ?? false;
    const skipEnrichment = opts.skipEnrichment ?? false;
    const hasExplicitLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit);
    const paginationLimit = hasExplicitLimit
      ? Math.max(1, Math.min(Math.trunc(opts.limit!), 10000))
      : Infinity;
    const rawOffset =
      typeof opts.offset === 'number' && Number.isFinite(opts.offset) ? opts.offset : 0;
    const paginationOffset = Math.max(0, Math.trunc(rawOffset));
    const summaryOnly = opts.summaryOnly ?? false;
    // Bind the BFS frontier query's filters as parameters (#1907 review F5):
    // node ids and relation types as bound lists, the confidence floor as a
    // bound number — no string interpolation reaches the query text. Preserve
    // the original "no confidence clause when minConfidence <= 0" behavior: an
    // unconditional `>= 0` would wrongly exclude NULL-confidence edges that the
    // unfiltered query includes.
    const safeMinConfidence = Number.isFinite(minConfidence) ? minConfidence : 0;
    const confidenceFilter = safeMinConfidence > 0 ? ' AND r.confidence >= $minConfidence' : '';

    const symId = sym.id || sym[0];

    // #1858 — kick off the epistemic boundary probe concurrently with the BFS.
    // It depends only on symId/symType/symName (all known now) and touches no
    // shared state, so its extra round-trip overlaps the traversal instead of
    // adding to the serial path. `skipEpistemic` (ambiguous #2129 candidate
    // probes, group fan-out) resolves to no field, preserving prior behavior.
    // #1858/#2129 review F8 — the skip case adds no field, so `epistemic` is
    // optional here (the union's `{}` subtype). computeEpistemicBoundary's own
    // return keeps `epistemic` REQUIRED — only this promise widens to the skip
    // subtype.
    const epistemicPromise: Promise<{
      epistemic?: 'exact' | 'lower-bound';
      boundaries?: string[];
    }> = opts.skipEpistemic
      ? Promise.resolve({})
      : this.computeEpistemicBoundary(repo, symId, symType, (sym.name || sym[1]) as string);

    const impacted: any[] = [];
    const visited = new Set<string>([symId]);
    const pdgBridgeEvidenceById = new Map<string, PdgBridgeEvidenceInfo>();
    let frontier = [symId];
    let traversalComplete = true;

    // Fix #480: For Java (and other JVM) Class/Interface nodes, CALLS edges
    // point to Constructor nodes and IMPORTS edges point to File nodes — not
    // the Class/Interface itself. Seed the frontier with the Constructor(s)
    // and owning File so the BFS traversal finds those edges naturally.
    // The owning File is kept only as an internal seed (frontier/visited) and
    // is NOT added to impacted — it is the definition container, not an
    // upstream dependent. The BFS will discover IMPORTS edges on it naturally.
    if (symType === 'Class' || symType === 'Interface') {
      try {
        // Run both seed queries in parallel — they are independent.
        const [ctorRows, fileRows] = await Promise.all([
          executeParameterized(
            repo.lbugPath,
            `
            MATCH (n)-[hm:CodeRelation]->(c:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            RETURN c.id AS id, c.name AS name, labels(c)[0] AS type, c.filePath AS filePath
          `,
            { symId },
          ),
          // Restrict to DEFINES edges only — other File->Class edge types (if
          // any) should not be treated as the owning file relationship.
          executeParameterized(
            repo.lbugPath,
            `
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            RETURN f.id AS id, f.name AS name, labels(f)[0] AS type, f.filePath AS filePath
          `,
            { symId },
          ),
        ]);

        for (const r of ctorRows) {
          const rid = r.id || r[0];
          if (rid && !visited.has(rid)) {
            visited.add(rid);
            frontier.push(rid);
          }
        }
        for (const r of fileRows) {
          const rid = r.id || r[0];
          if (rid && !visited.has(rid)) {
            visited.add(rid);
            frontier.push(rid);
          }
        }

        const typedPropertyRows = await executeParameterized(
          repo.lbugPath,
          `
          MATCH (p:\`Property\`)
          WHERE p.declaredType = $name
             OR p.declaredType STARTS WITH $genericPrefix
             OR p.declaredType CONTAINS $genericArg
          RETURN p.id AS id, p.name AS name, labels(p)[0] AS type, p.filePath AS filePath
        `,
          {
            name: sym.name,
            genericPrefix: `${sym.name}<`,
            genericArg: `<${sym.name}>`,
          },
        );

        for (const r of typedPropertyRows) {
          const rid = r.id || r[0];
          if (rid && !visited.has(rid)) {
            visited.add(rid);
            frontier.push(rid);
          }
        }
      } catch (e) {
        logQueryError('impact:class-node-expansion', e);
      }
    }

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      // Batch frontier nodes into a single Cypher query per depth level.
      // ids/types/confidence are bound parameters (see above) — no interpolation.
      const query =
        direction === 'upstream'
          ? `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN $frontierIds AND r.type IN $relTypes${confidenceFilter} RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, labels(caller)[0] AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence`
          : `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN $frontierIds AND r.type IN $relTypes${confidenceFilter} RETURN n.id AS sourceId, callee.id AS id, callee.name AS name, labels(callee)[0] AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence`;

      try {
        const related = await executeParameterized(repo.lbugPath, query, {
          frontierIds: frontier,
          relTypes: relationTypes,
          ...(safeMinConfidence > 0 ? { minConfidence: safeMinConfidence } : {}),
        });

        for (const rel of related) {
          const sourceId = String(rel.sourceId ?? rel[0] ?? '');
          const relId = rel.id || rel[1];
          const filePath = rel.filePath || rel[4] || '';

          if (!includeTests && isTestFilePath(filePath)) continue;

          // Bridge evidence is computed for EVERY edge (not just the first to
          // reach a node) and the strongest verdict across all parents is kept
          // (`callgraph-bridge` wins). This makes a diamond-reachable node's
          // proven/unproven label order-independent of DB row iteration; the
          // final label is stamped onto the impacted items after the depth loop.
          if (opts.pdgBridge) {
            const ev = pdgBridgeEvidenceForImpact({
              bridge: opts.pdgBridge,
              depth,
              calleeName: rel.name || rel[2],
              // Sound primary key (KTD3): the reached callee's RESOLVED id — the
              // same `relId` (`rel.id`) the BFS keys its visited/frontier sets on,
              // which equals the CALLS targetId captured into `BasicBlock.calleeIds`.
              // The bridge proves by id ∈ `sliceCalleeIds` first, falling back to
              // `calleeName` only when ids are absent or the block is capped.
              calleeId: relId,
              inherited: pdgBridgeEvidenceById.get(sourceId),
            });
            pdgBridgeEvidenceById.set(
              String(relId),
              betterBridgeEvidence(pdgBridgeEvidenceById.get(String(relId)), ev),
            );
          }

          if (!visited.has(relId)) {
            visited.add(relId);
            nextFrontier.push(relId);
            const storedConfidence = rel.confidence ?? rel[6];
            const relationType = rel.relType || rel[5];
            // Prefer the stored confidence from the graph (set at analysis time);
            // fall back to the per-type floor for edges without a stored value.
            const effectiveConfidence =
              typeof storedConfidence === 'number' && storedConfidence > 0
                ? storedConfidence
                : confidenceForRelType(relationType);
            // pdgEvidence is stamped after the depth loop from the finalized,
            // order-independent pdgBridgeEvidenceById map.
            impacted.push({
              depth,
              id: relId,
              name: rel.name || rel[2],
              type: rel.type || rel[3],
              filePath,
              relationType,
              confidence: effectiveConfidence,
            });
          }
        }
      } catch (e) {
        logQueryError('impact:depth-traversal', e);
        // Break out of depth loop on query failure but return partial results
        // collected so far, rather than silently swallowing the error (#321)
        traversalComplete = false;
        break;
      }

      frontier = nextFrontier;
    }

    // Stamp the finalized, order-independent bridge evidence (strongest across
    // all parents) onto each impacted item. Deferred from the BFS loop so a
    // diamond-reachable node reflects a proven parent regardless of visit order.
    if (opts.pdgBridge) {
      for (const item of impacted as Array<Record<string, unknown>>) {
        const ev = pdgBridgeEvidenceById.get(String(item.id));
        if (ev) {
          item.pdgEvidence = ev.evidence;
          item.pdgBridgeBasis = ev.basis;
        }
      }
    }

    const grouped: Record<number, any[]> = {};
    for (const item of impacted) {
      if (!grouped[item.depth]) grouped[item.depth] = [];
      grouped[item.depth].push(item);
    }

    // ── Enrichment: affected processes, modules, risk ──────────────
    const directCount = (grouped[1] || []).length;
    let affectedProcesses: any[] = [];
    let affectedModules: any[] = [];
    // Per-symbol process membership: maps impacted symbol id -> list of processes
    // it participates in. Populated by a second chunked Cypher pass below when
    // any process is affected at all. Surfaced as `processes: [...]` on each
    // byDepth item so consumers can tell which caller belongs to which cron/
    // webhook/route without a follow-up query.
    const perSymbolProcesses = new Map<
      string,
      Array<{ id: string; label: string; processType: string; step: number }>
    >();

    // Chunking bounds for batched DB round-trips. Declared at function scope so
    // both the in-block enrichment passes and the post-pagination per-symbol
    // process enrichment can reference them.
    const CHUNK_SIZE = 100;
    // Max number of chunks to process to avoid unbounded DB round-trips.
    // Configurable via env IMPACT_MAX_CHUNKS, default 10 => max items = 1000
    const MAX_CHUNKS = parseInt(process.env.IMPACT_MAX_CHUNKS || '10', 10);

    // `skipEnrichment` (ambiguous #2129 per-candidate probes) bypasses the
    // process/module aggregation passes entirely — those probes need only the
    // count + a count-based risk, so paying the bounded-but-real enrichment cost
    // ~6× per ambiguous call is wasted. risk then derives from directCount /
    // total only (processCount/moduleCount stay 0), an acceptable approximation
    // for a disambiguation aid.
    if (impacted.length > 0 && !skipEnrichment) {
      // ── Process enrichment: batched chunking (bounded by MAX_CHUNKS) ─
      // Uses merged Cypher query (WITH + OPTIONAL MATCH) to fetch
      // process + entry point info in 1 round-trip per chunk. Converted to
      // parameterized queries to avoid manual string escaping and long query strings.
      const entryPointMap = new Map<
        string,
        {
          name: string;
          type: string;
          filePath: string;
          affected_process_count: number;
          total_hits: number;
          earliest_broken_step: number;
        }
      >();

      // Map process id -> entryPointId to allow fixing missing minStep values later
      const processToEntryPoint = new Map<string, string>();
      // Collect process ids where MIN(r.step) returned null so we can retry in batch
      const processesMissingMinStep = new Set<string>();

      let chunksProcessed = 0;
      for (
        let i = 0;
        i < impacted.length && chunksProcessed < MAX_CHUNKS;
        i += CHUNK_SIZE, chunksProcessed++
      ) {
        const chunk = impacted.slice(i, i + CHUNK_SIZE);
        const ids = chunk.map((item) => String(item.id ?? ''));

        try {
          // Use parameterized list to avoid building long query strings
          const rows = await executeParameterized(
            repo.lbugPath,
            `
            MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
            WHERE s.id IN $ids
            WITH p, COUNT(DISTINCT s.id) AS hits, MIN(r.step) AS minStep
            OPTIONAL MATCH (ep {id: p.entryPointId})
            RETURN p.id AS pId, p.heuristicLabel AS name, p.processType AS processType,
                   p.entryPointId AS entryPointId, hits, minStep, p.stepCount AS stepCount,
                   ep.name AS epName, labels(ep)[0] AS epType, ep.filePath AS epFilePath
          `,
            { ids },
          ).catch(() => []);

          for (const row of rows) {
            const pId = row.pId ?? row[0];
            const epId = row.entryPointId ?? row[3] ?? row.pId ?? row[0];
            // Track mapping from process -> entryPoint so we can backfill missing minStep
            if (pId) processToEntryPoint.set(String(pId), String(epId));

            // Normalize epName: prefer epName, fall back to other columns, and
            // ensure we don't keep an empty string (labels(...) can return "").
            const epNameRaw = row.epName ?? row[7] ?? row.name ?? row[1] ?? 'unknown';
            const epName =
              typeof epNameRaw === 'string' && epNameRaw.trim().length > 0
                ? epNameRaw.trim()
                : 'unknown';

            // Normalize epType: labels(ep)[0] can return an empty string in
            // some DBs (LadybugDB). Using nullish coalescing (??) preserves
            // empty strings, which results in empty `type` values being
            // propagated. Treat empty-string labels as missing and fall back
            // to the next candidate or a sensible default.
            const epTypeRaw = row.epType ?? row[8] ?? '';
            const epType =
              typeof epTypeRaw === 'string' && epTypeRaw.trim().length > 0
                ? epTypeRaw.trim()
                : 'Function';

            const epFilePath = row.epFilePath ?? row[9] ?? '';
            const hits = row.hits ?? row[4] ?? 0;
            const minStep = row.minStep ?? row[5];
            // If the DB returned null for minStep, note the process id so we
            // can run a follow-up query using a different aggregation strategy.
            if (minStep === null || minStep === undefined) {
              if (pId) processesMissingMinStep.add(String(pId));
            }
            if (!entryPointMap.has(epId)) {
              entryPointMap.set(epId, {
                name: epName,
                type: epType,
                filePath: epFilePath,
                affected_process_count: 0,
                total_hits: 0,
                earliest_broken_step: Infinity,
              });
            }
            const ep = entryPointMap.get(epId)!;
            ep.affected_process_count += 1;
            ep.total_hits += hits;
            ep.earliest_broken_step = Math.min(ep.earliest_broken_step, minStep ?? Infinity);
          }
        } catch (e) {
          logQueryError('impact:process-chunk', e);
        }
      }

      // If some processes returned null minStep, try a batched follow-up query
      // using the full impacted id set. This handles older indexes or DBs
      // where MIN(r.step) can come back null even when step properties exist.
      if (processesMissingMinStep.size > 0) {
        try {
          const pIds = Array.from(processesMissingMinStep);
          const allImpactedIds = impacted.map((it) => String(it.id ?? ''));
          const missingRows = await executeParameterized(
            repo.lbugPath,
            `
            MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
            WHERE p.id IN $pIds AND s.id IN $ids
            RETURN p.id AS pid, MIN(r.step) AS minStep
          `,
            { pIds, ids: allImpactedIds },
          ).catch(() => []);

          for (const mr of missingRows) {
            const pid = mr.pid ?? mr[0];
            const minStep = mr.minStep ?? mr[1];
            const epId = processToEntryPoint.get(String(pid));
            if (!epId) continue;
            const ep = entryPointMap.get(epId);
            if (!ep) continue;
            if (typeof minStep === 'number') {
              ep.earliest_broken_step = Math.min(ep.earliest_broken_step, minStep);
            }
          }
        } catch (e) {
          logQueryError('impact:process-chunk-backfill', e);
        }
      }

      // If we capped chunks, mark traversal incomplete so caller knows results are partial
      if (chunksProcessed * CHUNK_SIZE < impacted.length) {
        traversalComplete = false;
      }

      affectedProcesses = Array.from(entryPointMap.values())
        .map((ep) => ({
          ...ep,
          earliest_broken_step:
            ep.earliest_broken_step === Infinity ? null : ep.earliest_broken_step,
        }))
        .sort((a, b) => b.total_hits - a.total_hits);

      // Per-symbol process membership is populated post-pagination (see below)
      // so it covers exactly the symbols returned in byDepth, not a pre-capped
      // flat slice that could miss depth-2+ symbols when depth-1 is large.

      // ── Module enrichment: use same cap as process enrichment and parameterized queries
      const maxItems = Math.min(impacted.length, MAX_CHUNKS * CHUNK_SIZE);
      const cappedImpacted = impacted.slice(0, maxItems);
      const allIdsArr = cappedImpacted.map((i: any) => String(i.id ?? ''));
      const d1Items = (grouped[1] || []).slice(0, maxItems);
      const d1IdsArr = d1Items.map((i: any) => String(i.id ?? ''));

      // Chunked module enrichment: run the MEMBER_OF queries in chunks
      // to avoid large single queries or concurrent Kuzu calls that can
      // crash (SIGSEGV) on arm64 macOS; behavior preserves existing maxItems cap and returns equivalent aggregated results.
      const moduleHitsMap = new Map<string, number>();
      const directModuleSet = new Set<string>();

      // Helper to run a single module chunk and accumulate hits by name
      const runModuleChunk = async (idsChunk: string[]) => {
        if (!idsChunk || idsChunk.length === 0) return;
        try {
          const rows = await executeParameterized(
            repo.lbugPath,
            `
            MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
            WHERE s.id IN $ids
            RETURN c.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits
            ORDER BY hits DESC
            LIMIT 20
          `,
            { ids: idsChunk },
          ).catch(() => []);

          for (const r of rows) {
            const name = r.name ?? r[0] ?? null;
            const hits = (r.hits ?? r[1]) || 0;
            if (!name) continue;
            moduleHitsMap.set(name, (moduleHitsMap.get(name) || 0) + hits);
          }
        } catch (e) {
          logQueryError('impact:module-chunk', e);
        }
      };

      // Run module query chunks sequentially (safe on arm64 macOS)
      for (let i = 0; i < allIdsArr.length; i += CHUNK_SIZE) {
        const chunkIds = allIdsArr.slice(i, i + CHUNK_SIZE);
        await runModuleChunk(chunkIds);
      }

      // Run direct module query similarly (distinct heuristic labels for depth-1 items)
      const runDirectModuleChunk = async (idsChunk: string[]) => {
        if (!idsChunk || idsChunk.length === 0) return;
        try {
          const rows = await executeParameterized(
            repo.lbugPath,
            `
            MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
            WHERE s.id IN $ids
            RETURN DISTINCT c.heuristicLabel AS name
          `,
            { ids: idsChunk },
          ).catch(() => []);
          for (const r of rows) {
            const name = r.name ?? r[0] ?? null;
            if (name) directModuleSet.add(name);
          }
        } catch (e) {
          logQueryError('impact:direct-module-chunk', e);
        }
      };

      for (let i = 0; i < d1IdsArr.length; i += CHUNK_SIZE) {
        const chunkIds = d1IdsArr.slice(i, i + CHUNK_SIZE);
        await runDirectModuleChunk(chunkIds);
      }

      // Build final moduleRows array from aggregated hits map, sorted & limited
      const moduleRows = Array.from(moduleHitsMap.entries())
        .map(([name, hits]) => ({ name, hits }))
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 20);

      const directModuleRows = Array.from(directModuleSet).map((name) => ({ name }));

      // Build affectedModules in the same shape as original implementation
      const directModuleNameSet = new Set(directModuleRows.map((r: any) => r.name || r[0]));
      affectedModules = moduleRows.map((r: any) => {
        const name = r.name ?? r[0];
        const hits = r.hits ?? r[1] ?? 0;
        return {
          name,
          hits,
          impact: directModuleNameSet.has(name) ? 'direct' : 'indirect',
        };
      });
    }

    // Risk scoring
    const processCount = affectedProcesses.length;
    const moduleCount = affectedModules.length;
    let risk = 'LOW';
    if (directCount >= 30 || processCount >= 5 || moduleCount >= 5 || impacted.length >= 200) {
      risk = 'CRITICAL';
    } else if (
      directCount >= 15 ||
      processCount >= 3 ||
      moduleCount >= 3 ||
      impacted.length >= 100
    ) {
      risk = 'HIGH';
    } else if (directCount >= 5 || impacted.length >= 30) {
      risk = 'MEDIUM';
    }

    // Build per-depth counts (always included, even in summaryOnly mode)
    const byDepthCounts: Record<number, number> = {};
    for (const [depth, items] of Object.entries(grouped)) {
      byDepthCounts[Number(depth)] = items.length;
    }

    // #1858 — await the epistemic boundary probe kicked off alongside the BFS
    // above. Additive: leaves impactedCount and every existing field untouched.
    const epistemic = await epistemicPromise;

    const base = {
      target: {
        id: symId,
        name: sym.name || sym[1],
        type: symType,
        filePath: sym.filePath || sym[2],
      },
      direction,
      impactedCount: impacted.length,
      risk,
      ...epistemic,
      ...(!traversalComplete && { partial: true }),
      summary: {
        direct: directCount,
        processes_affected: processCount,
        modules_affected: moduleCount,
      },
      byDepthCounts,
      affected_processes: affectedProcesses,
      affected_modules: affectedModules,
    };

    if (summaryOnly) {
      return base;
    }

    // Apply limit/offset pagination per depth level.
    const paginatedGrouped: Record<number, any[]> = {};
    let anyTruncated = false;
    for (const [depth, items] of Object.entries(grouped)) {
      const total = items.length;
      const sliced = items.slice(paginationOffset, paginationOffset + paginationLimit);
      paginatedGrouped[Number(depth)] = sliced;
      if (paginationOffset > 0 || paginationOffset + paginationLimit < total) {
        anyTruncated = true;
      }
    }

    // ── Per-symbol process membership enrichment (post-pagination) ───────
    // Runs after paginatedGrouped is built so we enrich only the IDs that
    // actually appear in the response. This eliminates the false-empty
    // processes:[] case where a depth-2+ symbol's flat position in `impacted`
    // exceeded MAX_CHUNKS*CHUNK_SIZE even though it is returned by byDepth.
    // Also uses DISTINCT + MIN(r.step) per (symbol, process) pair to avoid
    // duplicate entries when a symbol has multiple STEP_IN_PROCESS edges.
    // Skipped entirely when `skipPerSymbolEnrichment` is set (group cross-repo
    // fan-out, which consumes byDepth but not byDepth[].processes); the
    // attach-loop below still stamps an empty processes:[] for shape stability.
    let perSymbolEnrichmentCapped = false;
    if (affectedProcesses.length > 0 && !skipPerSymbolEnrichment) {
      // Collect unique IDs from the paginated result in one pass.
      const pageIds = new Set<string>();
      for (const items of Object.values(paginatedGrouped)) {
        for (const it of items) {
          const id = String(it.id ?? '');
          if (id) pageIds.add(id);
        }
      }
      // Bound the enrichment to the same ceiling as the aggregation pass
      // (MAX_CHUNKS * CHUNK_SIZE) so a large paginated page cannot trigger
      // unbounded DB round-trips (DoD 2.6). When capped, mark the result
      // partial so callers know some returned symbols may carry an empty
      // processes:[] that is a cap artifact, not a true absence.
      const maxPageIds = MAX_CHUNKS * CHUNK_SIZE;
      let pageIdArr = Array.from(pageIds);
      if (pageIdArr.length > maxPageIds) {
        pageIdArr = pageIdArr.slice(0, maxPageIds);
        perSymbolEnrichmentCapped = true;
      }
      for (let i = 0; i < pageIdArr.length; i += CHUNK_SIZE) {
        const chunkIds = pageIdArr.slice(i, i + CHUNK_SIZE);
        try {
          const rows = await executeParameterized(
            repo.lbugPath,
            `
            MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
            WHERE s.id IN $ids
            RETURN s.id AS sid, p.id AS pid, p.heuristicLabel AS pName,
                   p.processType AS pType, MIN(r.step) AS step
          `,
            { ids: chunkIds },
          ).catch(() => []);
          for (const row of rows) {
            const sid = row.sid ?? row[0];
            if (!sid) continue;
            const procEntry = {
              id: String(row.pid ?? row[1] ?? ''),
              label: String(row.pName ?? row[2] ?? ''),
              processType: String(row.pType ?? row[3] ?? ''),
              step: Number(row.step ?? row[4] ?? -1),
            };
            const list = perSymbolProcesses.get(String(sid));
            if (list) list.push(procEntry);
            else perSymbolProcesses.set(String(sid), [procEntry]);
          }
        } catch (e) {
          logQueryError('impact:per-symbol-process-chunk', e);
        }
      }
    }

    // Attach processes field to each paginated item.
    for (const items of Object.values(paginatedGrouped)) {
      for (const it of items) {
        it.processes = perSymbolProcesses.get(String(it.id)) ?? [];
      }
    }

    return {
      ...base,
      // Surface partial if the per-symbol enrichment was capped, even when the
      // BFS traversal itself completed — some returned symbols may carry an
      // empty processes:[] that is a cap artifact rather than a true absence.
      ...(perSymbolEnrichmentCapped && { partial: true }),
      ...(anyTruncated && {
        pagination: {
          ...(Number.isFinite(paginationLimit) && { limit: paginationLimit }),
          offset: paginationOffset,
          truncated: true,
        },
      }),
      byDepth: paginatedGrouped,
    };
  }

  /**
   * UID-based impact for cross-repo fan-out. Same result shape as `impact`.
   * Returns null if the repo is unknown, the UID is missing, or analysis fails.
   */
  async impactByUid(
    repoId: string,
    uid: string,
    direction: string,
    opts: {
      maxDepth: number;
      relationTypes: string[];
      minConfidence: number;
      includeTests: boolean;
      signal?: AbortSignal;
    },
  ): Promise<any | null> {
    // Honor an already-aborted signal at the entry boundary as a fast
    // path. Cooperative cancellation inside _runImpactBFS is out of
    // scope — the caller's Promise.race against the same signal
    // resolves the await regardless of how long this body runs.
    if (opts.signal?.aborted) return null;
    let repo: RepoHandle | undefined;
    try {
      await this.refreshRepos();
      // Fetch the resolved handle BEFORE init and pass it through, so a
      // concurrent refresh can't remap the id to a different clone (#2067).
      repo = this.repos.get(repoId);
      if (repo) await this.ensureInitialized(repo);
    } catch {
      return null;
    }
    if (!repo) return null; // unknown repo → null (preserves contract)

    const dir: 'upstream' | 'downstream' = direction === 'downstream' ? 'downstream' : 'upstream';

    let rows: any[];
    try {
      rows = await executeParameterized(
        repo.lbugPath, // pool keyed by the resolved clone's path, not the id
        `MATCH (n) WHERE n.id = $uid
         RETURN n.id AS id, n.name AS name, n.filePath AS filePath, labels(n)[0] AS type
         LIMIT 1`,
        { uid },
      );
    } catch {
      return null;
    }
    if (!rows?.length) return null;

    const sym = rows[0];
    const labelRaw = sym.type ?? sym[3];
    const symType =
      typeof labelRaw === 'string' && labelRaw.trim().length > 0 ? labelRaw.trim() : '';

    // Map legacy relation type names (backward compat for OVERRIDES → METHOD_OVERRIDES)
    const mappedRelTypes = opts.relationTypes?.flatMap((t: string) =>
      t === 'OVERRIDES' ? ['OVERRIDES', 'METHOD_OVERRIDES'] : [t],
    );
    const rawRelTypes =
      mappedRelTypes && mappedRelTypes.length > 0
        ? mappedRelTypes.filter((t: string) => VALID_RELATION_TYPES.has(t))
        : [
            'CALLS',
            'IMPORTS',
            'EXTENDS',
            'IMPLEMENTS',
            'METHOD_OVERRIDES',
            'OVERRIDES',
            'METHOD_IMPLEMENTS',
          ];
    const relationTypes =
      rawRelTypes.length > 0
        ? rawRelTypes
        : [
            'CALLS',
            'IMPORTS',
            'EXTENDS',
            'IMPLEMENTS',
            'METHOD_OVERRIDES',
            'OVERRIDES',
            'METHOD_IMPLEMENTS',
          ];

    try {
      // skipPerSymbolEnrichment suppresses ONLY the per-symbol STEP_IN_PROCESS
      // enrichment pass while preserving byDepth. Group-mode cross-repo fan-out
      // may fan across many repos; the per-symbol pass adds up to MAX_CHUNKS
      // extra round-trips per repo, which is unacceptable at group scale. But
      // cross-impact fan-out DOES consume byDepth (cross-impact.ts reads
      // fan.byDepth to populate group by_depth), so summaryOnly would wrongly
      // drop it. Group callers do not consume byDepth[].processes, so skipping
      // only that enrichment is the correct, targeted suppression.
      return await this._runImpactBFS(repo, sym, symType, dir, {
        maxDepth: opts.maxDepth,
        relationTypes,
        includeTests: opts.includeTests,
        minConfidence: opts.minConfidence,
        skipPerSymbolEnrichment: true,
        // Group cross-repo fan-out consumes only byDepth (cross-impact.ts), not
        // the #1858 epistemic/boundaries fields — computing them per neighbor is
        // dead work on the highest-volume path, so suppress them here too.
        skipEpistemic: true,
      });
    } catch {
      return null;
    }
  }

  private handleGroupTool(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'group_list':
        return this.groupList(params);
      case 'group_sync':
        return this.groupSync(params);
      default:
        throw new Error(
          `Unknown group tool: ${method}. Removed tools: use repo "@<groupName>" on impact, query, or context (optional "/<memberPath>"), or MCP resources.`,
        );
    }
  }

  /**
   * Dispatch impact/query/context when `repo` is `@groupName` or `@groupName/memberPath`
   * (group mode — not the global indexed-repo `repo` parameter).
   */
  private async callToolAtGroupRepo(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    await this.refreshRepos();

    if (
      params.service !== undefined &&
      params.service !== null &&
      String(params.service).trim() === ''
    ) {
      return { error: 'service must not be an empty string' };
    }

    const raw = String(params.repo).slice(1);
    const slash = raw.indexOf('/');
    const groupName = (slash === -1 ? raw : raw.slice(0, slash)).trim();
    const memberRest = slash === -1 ? undefined : raw.slice(slash + 1).trim() || undefined;

    const resolved = await resolveAtGroupMemberRepoPath(groupName, memberRest);
    if (resolved.ok === false) return { error: resolved.error };

    const svc = this.getGroupService();
    if (method === 'trace') {
      // Cross-repo trace resolves `from`/`to` across ALL members (it does not
      // anchor on a single member like impact/query/context), so the member
      // path in `@group/path` is advisory here — `resolved` above still
      // validates that the group exists. groupTrace owns cross-member
      // resolution and the single-boundary bridge crossing.
      const traceArgs: Record<string, unknown> = { name: groupName };
      if (params.from !== undefined) traceArgs.from = params.from;
      if (params.to !== undefined) traceArgs.to = params.to;
      if (params.from_uid !== undefined) traceArgs.from_uid = params.from_uid;
      if (params.to_uid !== undefined) traceArgs.to_uid = params.to_uid;
      if (params.from_file !== undefined) traceArgs.from_file = params.from_file;
      if (params.to_file !== undefined) traceArgs.to_file = params.to_file;
      if (params.maxDepth !== undefined) traceArgs.maxDepth = params.maxDepth;
      if (params.crossDepth !== undefined) traceArgs.crossDepth = params.crossDepth;
      if (params.includeTests !== undefined) traceArgs.includeTests = params.includeTests;
      if (params.pdg !== undefined) traceArgs.pdg = params.pdg;
      if (params.limit !== undefined) traceArgs.limit = params.limit;
      return svc.groupTrace(traceArgs);
    }
    if (method === 'impact') {
      // KTD5/KTD12 — validate `mode` at the group-forward boundary too (the
      // JSON-schema enum is advisory). An invalid mode errors; `mode:'pdg'` is
      // rejected for @group targets because PDG impact is single-repo and
      // intra-procedural — there is no cross-repo dependence graph to walk.
      // Rejecting here (before groupImpact) is the KTD12 @group hard error.
      const groupModeResult = validateImpactMode(params.mode);
      if ('error' in groupModeResult) return { error: groupModeResult.error };
      if (groupModeResult.mode === 'pdg') {
        // @group reject: no single-repo symbol is ever resolved on the group path,
        // so the envelope carries the partial-but-typed target (PdgImpactTarget).
        // Routed through the typed builder so this exit is a PdgImpactResult union
        // member, never a bare { error } object.
        const groupRejectTarget: PdgImpactTarget = { name: String(params.target ?? '') };
        const pdgErr: PdgImpactErrorResult = makePdgImpactErrorResult({
          mode: 'pdg',
          error:
            "mode:'pdg' is not supported for @group targets — PDG impact is " +
            'single-repo and intra-procedural. Run pdg impact against an ' +
            'individual indexed repository instead.',
          target: groupRejectTarget,
          direction: (params.direction === 'downstream' ? 'downstream' : 'upstream') as
            | 'upstream'
            | 'downstream',
        });
        return pdgErr;
      }
      const impactArgs: Record<string, unknown> = {
        name: groupName,
        repo: resolved.repoPath,
        target: params.target,
        direction: params.direction,
      };
      if (params.maxDepth !== undefined) impactArgs.maxDepth = params.maxDepth;
      if (params.crossDepth !== undefined) impactArgs.crossDepth = params.crossDepth;
      if (params.relationTypes !== undefined) impactArgs.relationTypes = params.relationTypes;
      if (params.includeTests !== undefined) impactArgs.includeTests = params.includeTests;
      if (params.minConfidence !== undefined) impactArgs.minConfidence = params.minConfidence;
      if (params.service !== undefined && params.service !== null)
        impactArgs.service = params.service;
      if (typeof params.subgroup === 'string') impactArgs.subgroup = params.subgroup;
      if (params.timeoutMs !== undefined) impactArgs.timeoutMs = params.timeoutMs;
      if (params.timeout !== undefined) impactArgs.timeout = params.timeout;
      // limit/offset/summaryOnly are not forwarded to group-mode impact:
      // runGroupImpact uses GROUP_LOCAL_PHASE_LIMIT internally for UID
      // collection and does not re-paginate the local result yet.
      return svc.groupImpact(impactArgs);
    }
    if (method === 'query') {
      const queryArgs: Record<string, unknown> = {
        name: groupName,
        // #2175: resolve the search_query alias here (new name wins, same rule as the
        // local query() handler) so the group path is self-contained and does not depend
        // on params being normalized upstream. groupQuery() reads `query`.
        query: resolveAliasString(params.search_query, params.query),
      };
      if (typeof params.task_context === 'string') queryArgs.task_context = params.task_context;
      if (typeof params.goal === 'string') queryArgs.goal = params.goal;
      if (typeof params.limit === 'number') queryArgs.limit = params.limit;
      if (typeof params.max_symbols === 'number') queryArgs.max_symbols = params.max_symbols;
      if (params.include_content !== undefined) queryArgs.include_content = params.include_content;
      if (params.service !== undefined && params.service !== null)
        queryArgs.service = params.service;
      if (memberRest !== undefined) {
        queryArgs.subgroup = memberRest;
        queryArgs.subgroupExact = true;
      }
      return svc.groupQuery(queryArgs);
    }
    if (method === 'context') {
      const targetSym =
        typeof params.target === 'string' && params.target.trim() !== ''
          ? params.target.trim()
          : typeof params.name === 'string' && params.name.trim() !== ''
            ? params.name.trim()
            : undefined;
      const contextArgs: Record<string, unknown> = {
        name: groupName,
        target: targetSym,
      };
      if (typeof params.uid === 'string') contextArgs.uid = params.uid;
      if (typeof params.file_path === 'string') contextArgs.file_path = params.file_path;
      if (params.include_content !== undefined)
        contextArgs.include_content = params.include_content;
      if (params.service !== undefined && params.service !== null)
        contextArgs.service = params.service;
      if (memberRest !== undefined) {
        contextArgs.subgroup = memberRest;
        contextArgs.subgroupExact = true;
      }
      return svc.groupContext(contextArgs);
    }
    throw new Error(`Internal: unsupported group-repo tool ${method}`);
  }

  private async groupList(params: Record<string, unknown>): Promise<unknown> {
    return this.getGroupService().groupList(params);
  }

  private async groupSync(params: Record<string, unknown>): Promise<unknown> {
    return this.getGroupService().groupSync(params);
  }

  /**
   * MCP resource body for `gitnexus://group/{name}/contracts` (Issue #794).
   */
  async readGroupContractsResource(
    groupName: string,
    filter: { type?: string; repo?: string; unmatchedOnly?: boolean },
  ): Promise<string> {
    try {
      const params: Record<string, unknown> = { name: groupName };
      if (filter.type !== undefined) params.type = filter.type;
      if (filter.repo !== undefined) params.repo = filter.repo;
      if (filter.unmatchedOnly === true) params.unmatchedOnly = true;
      const raw = await this.getGroupService().groupContracts(params);
      return LocalBackend.formatGroupResourcePayload(raw);
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * MCP resource body for `gitnexus://group/{name}/status` (Issue #794).
   */
  async readGroupStatusResource(groupName: string): Promise<string> {
    try {
      const raw = await this.getGroupService().groupStatus({ name: groupName });
      return LocalBackend.formatGroupResourcePayload(raw);
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private static formatGroupResourcePayload(raw: unknown): string {
    if (raw && typeof raw === 'object' && 'error' in raw) {
      const err = (raw as { error?: unknown }).error;
      if (typeof err === 'string' && err.length > 0) {
        return `error: ${err}`;
      }
    }
    return JSON.stringify(raw, null, 2);
  }

  /**
   * Fetch Route nodes with their consumers in a single query.
   * Shared by routeMap and shapeCheck to avoid N+1 query patterns.
   */
  private async fetchRoutesWithConsumers(
    repoId: string,
    routeFilter: string,
    params: Record<string, string>,
  ): Promise<
    Array<{
      id: string;
      name: string;
      method: string | null;
      filePath: string;
      responseKeys: string[] | null;
      errorKeys: string[] | null;
      middleware: string[] | null;
      consumers: Array<{
        name: string;
        filePath: string;
        accessedKeys?: string[];
        fetchCount?: number;
      }>;
    }>
  > {
    const rows = await executeParameterized(
      repoId,
      `
      MATCH (n:Route)
      WHERE n.id STARTS WITH 'Route:' ${routeFilter}
      OPTIONAL MATCH (consumer)-[r:CodeRelation]->(n)
      WHERE r.type = 'FETCHES'
      RETURN n.id AS routeId, n.name AS routeName, n.filePath AS handlerFile,
             n.responseKeys AS responseKeys, n.errorKeys AS errorKeys, n.middleware AS middleware,
             consumer.name AS consumerName, consumer.filePath AS consumerFile,
             r.reason AS fetchReason, n.method AS method
    `,
      params,
    );

    // Strip wrapping quotes from DB array elements — CSV COPY stores ['key'] which
    // LadybugDB may return as "'key'" rather than "key"
    const stripQuotes = (keys: string[] | null): string[] | null =>
      keys ? keys.map((k) => k.replace(/^['"]|['"]$/g, '')) : null;

    const routeMap = new Map<
      string,
      {
        id: string;
        name: string;
        method: string | null;
        filePath: string;
        responseKeys: string[] | null;
        errorKeys: string[] | null;
        middleware: string[] | null;
        consumers: Array<{
          name: string;
          filePath: string;
          accessedKeys?: string[];
          fetchCount?: number;
        }>;
      }
    >();
    for (const row of rows) {
      const id = row.routeId ?? row[0];
      const name = row.routeName ?? row[1];
      const filePath = row.handlerFile ?? row[2];
      const responseKeys = stripQuotes(row.responseKeys ?? row[3] ?? null);
      const errorKeys = stripQuotes(row.errorKeys ?? row[4] ?? null);
      const middleware = stripQuotes(row.middleware ?? row[5] ?? null);
      const consumerName = row.consumerName ?? row[6];
      const consumerFile = row.consumerFile ?? row[7];
      const fetchReason: string | null = row.fetchReason ?? row[8] ?? null;
      // Verb is the literal '*' for method-agnostic routes (Django function
      // views) and absent (null) for method-less routes (filesystem, Laravel
      // resource). Appended last in RETURN so positional fallbacks for the
      // consumer/reason columns above stay stable.
      const method: string | null = row.method ?? row[9] ?? null;

      if (!routeMap.has(id)) {
        routeMap.set(id, {
          id,
          name,
          method,
          filePath,
          responseKeys,
          errorKeys,
          middleware,
          consumers: [],
        });
      }
      if (consumerName && consumerFile) {
        // Parse accessed keys from reason field: "fetch-url-match|keys:data,pagination|fetches:3"
        let accessedKeys: string[] | undefined;
        let fetchCount: number | undefined;
        if (fetchReason) {
          const keysMatch = fetchReason.match(/\|keys:([^|]+)/);
          if (keysMatch) {
            accessedKeys = keysMatch[1].split(',').filter((k) => k.length > 0);
          }
          const fetchesMatch = fetchReason.match(/\|fetches:(\d+)/);
          if (fetchesMatch) {
            fetchCount = parseInt(fetchesMatch[1], 10);
          }
        }
        routeMap.get(id)!.consumers.push({
          name: consumerName,
          filePath: consumerFile,
          ...(accessedKeys ? { accessedKeys } : {}),
          ...(fetchCount && fetchCount > 1 ? { fetchCount } : {}),
        });
      }
    }

    return [...routeMap.values()];
  }

  /**
   * Batch-fetch execution flows linked to a set of Route or Tool nodes.
   * Single query instead of N+1.
   */
  private async fetchLinkedFlowsBatch(
    repoId: string,
    nodeIds: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (nodeIds.length === 0) return result;
    try {
      // Use list_contains to filter at DB level instead of fetching all and filtering in memory
      const rows = await executeParameterized(
        repoId,
        `
        MATCH (source)-[r:CodeRelation]->(proc:Process)
        WHERE r.type = 'ENTRY_POINT_OF'
          AND list_contains($nodeIds, source.id)
        RETURN source.id AS sourceId, proc.label AS name
      `,
        { nodeIds },
      );
      for (const row of rows) {
        const sourceId = row.sourceId ?? row[0];
        const name = row.name ?? row[1];
        if (!name) continue;
        let list = result.get(sourceId);
        if (!list) {
          list = [];
          result.set(sourceId, list);
        }
        list.push(name);
      }
    } catch {
      /* no ENTRY_POINT_OF edges yet */
    }
    return result;
  }

  private async routeMap(repo: RepoHandle, params: { route?: string }): Promise<any> {
    await this.ensureInitialized(repo);

    const routeFilter = params.route ? `AND n.name CONTAINS $route` : '';
    const queryParams = params.route ? { route: params.route } : {};
    const routes = await this.fetchRoutesWithConsumers(repo.lbugPath, routeFilter, queryParams);

    if (routes.length === 0) {
      return {
        routes: [],
        total: 0,
        message: params.route
          ? `No routes matching "${params.route}"`
          : 'No routes found in this project.',
      };
    }

    const flowMap = await this.fetchLinkedFlowsBatch(
      repo.lbugPath,
      routes.map((r) => r.id),
    );

    return {
      routes: routes.map((r) => ({
        route: r.name,
        method: r.method,
        handler: r.filePath,
        middleware: r.middleware || [],
        consumers: r.consumers,
        flows: flowMap.get(r.id) || [],
      })),
      total: routes.length,
    };
  }

  private async shapeCheck(repo: RepoHandle, params: { route?: string }): Promise<any> {
    await this.ensureInitialized(repo);

    const routeFilter = params.route ? `AND n.name CONTAINS $route` : '';
    const queryParams = params.route ? { route: params.route } : {};
    const allRoutes = await this.fetchRoutesWithConsumers(repo.lbugPath, routeFilter, queryParams);

    const results = allRoutes
      .filter(
        (r) =>
          ((r.responseKeys && r.responseKeys.length > 0) ||
            (r.errorKeys && r.errorKeys.length > 0)) &&
          r.consumers.length > 0,
      )
      .map((r) => {
        // Keys already normalized by fetchRoutesWithConsumers (quotes stripped)
        const responseKeys = r.responseKeys ?? [];
        const errorKeys = r.errorKeys ?? [];
        // Combined set: consumer accessing either success or error keys is valid
        const allKnownKeys = new Set([...responseKeys, ...errorKeys]);

        // Check each consumer's accessed keys against the route's response shape
        const responseKeySet = new Set(responseKeys);
        const consumers = r.consumers.map((c) => {
          if (!c.accessedKeys || c.accessedKeys.length === 0) {
            return { name: c.name, filePath: c.filePath };
          }
          const mismatched = c.accessedKeys.filter((k) => !allKnownKeys.has(k));
          // Keys in allKnownKeys but not in responseKeys — error-path access (e.g., .error from errorKeys)
          const errorPathKeys = c.accessedKeys.filter(
            (k) => allKnownKeys.has(k) && !responseKeySet.has(k),
          );
          const isMultiFetch = (c.fetchCount ?? 1) > 1;
          return {
            name: c.name,
            filePath: c.filePath,
            accessedKeys: c.accessedKeys,
            ...(mismatched.length > 0
              ? {
                  mismatched,
                  mismatchConfidence: isMultiFetch ? ('low' as const) : ('high' as const),
                }
              : {}),
            ...(errorPathKeys.length > 0 ? { errorPathKeys } : {}),
            ...(isMultiFetch
              ? {
                  attributionNote: `This file fetches ${c.fetchCount} routes — accessed keys may belong to a different route.`,
                }
              : {}),
          };
        });

        const hasMismatches = consumers.some(
          (c) => 'mismatched' in c && (c as any).mismatched.length > 0,
        );

        return {
          route: r.name,
          method: r.method,
          handler: r.filePath,
          ...(responseKeys.length > 0 ? { responseKeys } : {}),
          ...(errorKeys.length > 0 ? { errorKeys } : {}),
          consumers,
          ...(hasMismatches ? { status: 'MISMATCH' as const } : {}),
        };
      });

    const mismatchCount = results.filter((r) => r.status === 'MISMATCH').length;

    return {
      routes: results,
      total: results.length,
      routesWithShapes: results.length,
      ...(mismatchCount > 0 ? { mismatches: mismatchCount } : {}),
      message:
        results.length === 0
          ? 'No routes with both response shapes and consumers found.'
          : mismatchCount > 0
            ? `Found ${results.length} route(s) with response shape data. ${mismatchCount} route(s) have consumer/shape mismatches.`
            : `Found ${results.length} route(s) with response shape data and consumers.`,
    };
  }

  private async toolMap(repo: RepoHandle, params: { tool?: string }): Promise<any> {
    await this.ensureInitialized(repo);

    const toolFilter = params.tool ? `AND n.name CONTAINS $tool` : '';
    const queryParams = params.tool ? { tool: params.tool } : {};

    const rows = await executeParameterized(
      repo.lbugPath,
      `
      MATCH (n:Tool)
      WHERE n.id STARTS WITH 'Tool:' ${toolFilter}
      RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.description AS description
    `,
      queryParams,
    );

    if (rows.length === 0) {
      return {
        tools: [],
        total: 0,
        message: params.tool ? `No tools matching "${params.tool}"` : 'No tool definitions found.',
      };
    }

    const toolIds = rows.map((r: any) => r.id ?? r[0]);
    const flowMap = await this.fetchLinkedFlowsBatch(repo.lbugPath, toolIds);

    return {
      tools: rows.map((r: any) => {
        const id = r.id ?? r[0];
        return {
          name: r.name ?? r[1],
          filePath: r.filePath ?? r[2],
          description: (r.description ?? r[3] ?? '').slice(0, 200),
          flows: flowMap.get(id) || [],
        };
      }),
      total: rows.length,
    };
  }

  private async apiImpact(
    repo: RepoHandle,
    params: { route?: string; file?: string; method?: unknown },
  ): Promise<ApiImpactResult> {
    await this.ensureInitialized(repo);

    if (!params.route && !params.file) {
      return { error: 'Either "route" or "file" parameter is required.' };
    }

    // If file is provided but route is not, look up the route by file path
    let routeFilter = '';
    const queryParams: Record<string, string> = {};

    if (params.route) {
      routeFilter = `AND n.name CONTAINS $route`;
      queryParams.route = params.route;
    } else if (params.file) {
      routeFilter = `AND n.filePath CONTAINS $file`;
      queryParams.file = params.file;
    }

    // After #2302 the same URL/handler can expose one Route node per HTTP verb.
    // An optional `method` narrows to that one verb so the response collapses to
    // the singular shape. A method-agnostic route (method `'*'`, e.g. a Django
    // function view) matches any selector; verbless routes (null method) never do.
    // `method` arrives unvalidated from the MCP envelope (the JSON schema is
    // advisory), so reject a non-string verb with a structured error instead of
    // throwing on `.toUpperCase()`; empty/whitespace collapses to no selector.
    const rawMethod = params.method;
    if (rawMethod !== undefined && typeof rawMethod !== 'string') {
      return { error: '"method" must be a string (e.g. "GET", "POST").' };
    }
    const wantedMethod =
      typeof rawMethod === 'string' ? rawMethod.trim().toUpperCase() || undefined : undefined;
    const matched = await this.fetchRoutesWithConsumers(repo.lbugPath, routeFilter, queryParams);
    const routes = matched.filter(
      (r) => !wantedMethod || r.method === '*' || r.method?.toUpperCase() === wantedMethod,
    );

    if (routes.length === 0) {
      const target = params.route || params.file;
      // Only append the verb when the URL/file matched routes but none used it;
      // a non-existent URL/file gets the plain "no routes found" message.
      const verb = wantedMethod && matched.length > 0 ? ` with method "${wantedMethod}"` : '';
      return { error: `No routes found matching "${target}"${verb}.` };
    }

    const flowMap = await this.fetchLinkedFlowsBatch(
      repo.lbugPath,
      routes.map((r) => r.id),
    );

    // Count verbs per handler from the FULL match (before the method filter) so a
    // method-scoped query still flags a multi-verb handler's partial middleware.
    const routeCountByHandler = new Map<string, number>();
    for (const r of matched) {
      if (r.filePath) {
        routeCountByHandler.set(r.filePath, (routeCountByHandler.get(r.filePath) ?? 0) + 1);
      }
    }

    const results: ApiImpactRoute[] = routes.map((r) => {
      // Keys already normalized by fetchRoutesWithConsumers (quotes stripped)
      const responseKeys = r.responseKeys ?? [];
      const errorKeys = r.errorKeys ?? [];
      const allKnownKeys = new Set([...responseKeys, ...errorKeys]);

      // Build consumer list with mismatch detection
      const consumers = r.consumers.map((c) => ({
        name: c.name,
        file: c.filePath,
        accesses: c.accessedKeys ?? [],
        ...(c.fetchCount && c.fetchCount > 1
          ? {
              attributionNote: `This file fetches ${c.fetchCount} routes — accessed keys may belong to a different route.`,
            }
          : {}),
      }));

      // Detect mismatches: consumer accesses keys not in response shape
      const mismatches: Array<{
        consumer: string;
        field: string;
        reason: string;
        confidence: 'high' | 'low';
      }> = [];
      if (allKnownKeys.size > 0) {
        for (const c of r.consumers) {
          if (!c.accessedKeys) continue;
          const isMultiFetch = (c.fetchCount ?? 1) > 1;
          for (const key of c.accessedKeys) {
            if (!allKnownKeys.has(key)) {
              mismatches.push({
                consumer: c.filePath,
                field: key,
                reason: 'accessed but not in response shape',
                confidence: isMultiFetch ? 'low' : 'high',
              });
            }
          }
        }
      }

      const flows = flowMap.get(r.id) || [];
      const consumerCount = r.consumers.length;

      // Risk level heuristic
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
      if (consumerCount >= 10) {
        riskLevel = 'HIGH';
      } else if (consumerCount >= 4) {
        riskLevel = 'MEDIUM';
      } else {
        riskLevel = 'LOW';
      }
      // Bump up one level if mismatches exist
      if (mismatches.length > 0) {
        if (riskLevel === 'LOW') riskLevel = 'MEDIUM';
        else if (riskLevel === 'MEDIUM') riskLevel = 'HIGH';
      }

      const warning =
        consumerCount > 0
          ? `Changing response shape will affect ${consumerCount} component${consumerCount === 1 ? '' : 's'}`
          : undefined;

      // Flag when middleware was detected but handler exports multiple HTTP methods
      // (middleware chain may only reflect one export)
      const middlewareArr = r.middleware || [];
      const handlerRouteCount = r.filePath ? (routeCountByHandler.get(r.filePath) ?? 1) : 1;
      const middlewarePartial = middlewareArr.length > 0 && handlerRouteCount > 1;

      return {
        route: r.name,
        method: r.method,
        handler: r.filePath,
        responseShape: {
          success: responseKeys,
          error: errorKeys,
        },
        middleware: middlewareArr,
        ...(middlewarePartial
          ? {
              middlewareDetection: 'partial' as const,
              middlewareNote:
                'Middleware captured from the first route export only — other route exports in this handler may use different middleware chains.',
            }
          : {}),
        consumers,
        ...(mismatches.length > 0 ? { mismatches } : {}),
        executionFlows: flows,
        impactSummary: {
          directConsumers: consumerCount,
          affectedFlows: flows.length,
          riskLevel,
          ...(warning ? { warning } : {}),
        },
      };
    });

    // If a single route was targeted, return it directly (not wrapped in array)
    if (results.length === 1) {
      return results[0];
    }

    return { routes: results, total: results.length };
  }

  // ─── Direct Graph Queries (for resources.ts) ────────────────────

  /**
   * Query clusters (communities) directly from graph.
   * Used by getClustersResource — avoids legacy overview() dispatch.
   */
  async queryClusters(repoName?: string, limit = 100): Promise<{ clusters: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo);

    try {
      const rawLimit = Math.max(limit * 5, 200);
      const clusters = await executeQuery(
        repo.lbugPath,
        `
        MATCH (c:Community)
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
        ORDER BY c.symbolCount DESC
        LIMIT ${rawLimit}
      `,
      );
      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0],
        label: c.label || c[1],
        heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3],
        symbolCount: c.symbolCount || c[4],
      }));
      return { clusters: this.aggregateClusters(rawClusters).slice(0, limit) };
    } catch {
      return { clusters: [] };
    }
  }

  /**
   * Query processes directly from graph.
   * Used by getProcessesResource — avoids legacy overview() dispatch.
   */
  async queryProcesses(repoName?: string, limit = 50): Promise<{ processes: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo);

    try {
      const processes = await executeQuery(
        repo.lbugPath,
        `
        MATCH (p:Process)
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        ORDER BY p.stepCount DESC
        LIMIT ${limit}
      `,
      );
      return {
        processes: processes.map((p: any) => ({
          id: p.id || p[0],
          label: p.label || p[1],
          heuristicLabel: p.heuristicLabel || p[2],
          processType: p.processType || p[3],
          stepCount: p.stepCount || p[4],
        })),
      };
    } catch {
      return { processes: [] };
    }
  }

  /**
   * Query cluster detail (members) directly from graph.
   * Used by getClusterDetailResource.
   */
  async queryClusterDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo);

    const clusters = await executeParameterized(
      repo.lbugPath,
      `
      MATCH (c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
    `,
      { clusterName: name },
    );
    if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

    const rawClusters = clusters.map((c: any) => ({
      id: c.id || c[0],
      label: c.label || c[1],
      heuristicLabel: c.heuristicLabel || c[2],
      cohesion: c.cohesion || c[3],
      symbolCount: c.symbolCount || c[4],
    }));

    let totalSymbols = 0,
      weightedCohesion = 0;
    for (const c of rawClusters) {
      const s = c.symbolCount || 0;
      totalSymbols += s;
      weightedCohesion += (c.cohesion || 0) * s;
    }

    const members = await executeParameterized(
      repo.lbugPath,
      `
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
      LIMIT 30
    `,
      { clusterName: name },
    );

    return {
      cluster: {
        id: rawClusters[0].id,
        label: rawClusters[0].heuristicLabel || rawClusters[0].label,
        heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
        cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
        symbolCount: totalSymbols,
        subCommunities: rawClusters.length,
      },
      members: members.map((m: any) => ({
        name: m.name || m[0],
        type: m.type || m[1],
        filePath: m.filePath || m[2],
      })),
    };
  }

  /**
   * Query process detail (steps) directly from graph.
   * Used by getProcessDetailResource.
   */
  async queryProcessDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo);

    const processes = await executeParameterized(
      repo.lbugPath,
      `
      MATCH (p:Process)
      WHERE p.label = $processName OR p.heuristicLabel = $processName
      RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
      LIMIT 1
    `,
      { processName: name },
    );
    if (processes.length === 0) return { error: `Process '${name}' not found` };

    const proc = processes[0];
    const procId = proc.id || proc[0];
    const steps = await executeParameterized(
      repo.lbugPath,
      `
      MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
      RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
      ORDER BY r.step
    `,
      { procId },
    );

    return {
      process: {
        id: procId,
        label: proc.label || proc[1],
        heuristicLabel: proc.heuristicLabel || proc[2],
        processType: proc.processType || proc[3],
        stepCount: proc.stepCount || proc[4],
      },
      steps: steps.map((s: any) => ({
        step: s.step || s[3],
        name: s.name || s[0],
        type: s.type || s[1],
        filePath: s.filePath || s[2],
      })),
    };
  }

  async disconnect(): Promise<void> {
    await closeLbug(); // close all connections
    // Note: we intentionally do NOT call disposeEmbedder() here.
    // ONNX Runtime's native cleanup segfaults on macOS and some Linux configs,
    // and importing the embedder module on Node v24+ crashes if onnxruntime
    // was never loaded during the session. Since process.exit(0) follows
    // immediately after disconnect(), the OS reclaims everything. See #38, #89.
    this.repos.clear();
    this.contextCache.clear();
    this.initializedRepos.clear();
  }
}
