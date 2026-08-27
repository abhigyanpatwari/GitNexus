export type ContractType = 'http' | 'grpc' | 'thrift' | 'topic' | 'lib' | 'custom' | 'include';
export type MatchType = 'exact' | 'manifest' | 'wildcard';
export type ContractRole = 'provider' | 'consumer';

export interface GroupConfig {
  version: number;
  name: string;
  description: string;
  repos: Record<string, string>;
  links: GroupManifestLink[];
  packages: Record<string, Record<string, string>>;
  detect: DetectConfig;
  matching: MatchingConfig;
}

export interface GroupManifestLink {
  from: string;
  to: string;
  type: ContractType;
  contract: string;
  role: ContractRole;
}

export interface DetectConfig {
  http: boolean;
  grpc: boolean;
  thrift: boolean;
  topics: boolean;
  shared_libs: boolean;
  includes: boolean;
  workspace_deps: boolean;
}

export interface MatchingConfig {
  max_candidates_per_step: number;
  /**
   * HTTP paths to exclude from cross-link matching. Contracts at these paths
   * are still extracted and visible in the registry, but they don't produce
   * cross-repo links. Useful for health-check endpoints (`/ping`, `/health`)
   * that every service exposes and would otherwise create N×M false links.
   * Trailing slashes are normalized before comparison.
   * @default []
   */
  exclude_links_paths?: string[];
  /**
   * When `true`, exclude HTTP routes where every path segment is `{param}`
   * (e.g. `/{param}`, `/{param}/{param}`) from cross-link matching. Mixed
   * routes like `/users/{param}` are not affected. These param-only routes
   * collapse to a single catch-all after normalization and produce false
   * positives across unrelated services.
   * @default false
   */
  exclude_links_param_only_paths?: boolean;
}

export interface SymbolRef {
  filePath: string;
  name: string;
}

export interface ExtractedContract {
  contractId: string;
  type: ContractType;
  role: ContractRole;
  symbolUid: string;
  symbolRef: SymbolRef;
  symbolName: string;
  confidence: number;
  meta: Record<string, unknown>;
  /** Service boundary within a monorepo (relative path from repo root, e.g. "services/auth"). */
  service?: string;
}

export interface CrossLinkEndpoint {
  repo: string;
  /** Service boundary within a monorepo (relative path from repo root). */
  service?: string;
  symbolUid: string;
  symbolRef: SymbolRef;
}

export interface CrossLink {
  from: CrossLinkEndpoint;
  to: CrossLinkEndpoint;
  type: ContractType;
  contractId: string;
  matchType: MatchType;
  confidence: number;
}

export interface RepoSnapshot {
  indexedAt: string;
  lastCommit: string;
}

export interface ContractRegistry {
  version: number;
  generatedAt: string;
  repoSnapshots: Record<string, RepoSnapshot>;
  /** Configured repos with no entry in the registry. */
  missingRepos: string[];
  /**
   * Configured repos that ARE registered but that this sync could not extract
   * from — the index would not open (version skew, lock, corruption), or an
   * extractor threw partway through. The two are one bucket because the
   * consequence is one thing: NONE of that repo's contracts are in this
   * registry. Distinct from `missingRepos`, which is "no entry in the
   * registry at all" and needs a different answer from the operator.
   *
   * Optional so a registry written before this field existed still parses —
   * absent means "not recorded", not "none".
   */
  unreadableRepos?: string[];
  /**
   * Matching stages this sync was ASKED to skip, so a later reader can tell a
   * short cross-link list from a complete one. `--exact-only` / `exactOnly`
   * suppresses the wildcard stage, and the registry it writes is otherwise
   * indistinguishable from one where that stage ran and matched nothing.
   *
   * Same tri-state as `unreadableRepos` and for the same reason: absent means
   * "not recorded" (written before this field existed), `[]` means "measured,
   * nothing was suppressed", and a populated list names the stages. Distinct
   * from `truncated` / `truncationReason`, which report limits this run hit by
   * accident — a suppressed stage is a deliberate request, and its remedy is
   * "re-sync without exactOnly", not "fix the unreadable repo".
   */
  suppressedMatchStages?: MatchType[];
  contracts: StoredContract[];
  crossLinks: CrossLink[];
}

export interface StoredContract extends ExtractedContract {
  repo: string;
}

/** Repo within a group (group path + paths; name collision with MCP RepoHandle — import from group/types only). */
export interface RepoHandle {
  id: string;
  path: string;
  repoPath: string;
  storagePath: string;
}

/**
 * Why local impact or fan-out stopped early (e.g. wall-clock budget exhausted).
 *
 * `'timeout'` and `'partial'` are runtime limits — the same query can succeed on
 * a retry. `'incomplete-sync'` is structural: the bridge itself was built from a
 * sync that could not read every configured repo, so those repos' contracts are
 * absent from every query against it until `gitnexus group sync` succeeds.
 *
 * A runtime array rather than a bare type union: every value here has to be
 * explained on the agent-facing surface that returns it, and only an enumerable
 * list lets a guard test assert that. A test that hand-lists the members passes
 * forever once a fourth is added — which is the exact drift the guard exists to
 * catch, so the list an agent is promised and the list the code can emit have
 * to come from the same place.
 */
export const GROUP_IMPACT_TRUNCATION_REASONS = ['timeout', 'partial', 'incomplete-sync'] as const;

export type GroupImpactTruncationReason = (typeof GROUP_IMPACT_TRUNCATION_REASONS)[number];

export interface GroupImpactResult {
  local: unknown;
  group: string;
  cross: CrossRepoImpact[];
  outOfScope: OutOfScopeLink[];
  truncated: boolean;
  truncatedRepos: string[];
  summary: {
    direct: number;
    processes_affected: number;
    modules_affected: number;
    cross_repo_hits: number;
  };
  risk: string;
  /**
   * `'lower-bound'` when the fan-out was cut short, so `risk` is a FLOOR, not a
   * verdict. Same vocabulary as single-repo `impact`'s `epistemic` field.
   *
   * `mergeRisk` is monotone increasing in the number of traversed crossings, so
   * dropping a crossing can only move the reported risk DOWN — a fully
   * truncated fan-out returns bare `localRisk`, making a symbol whose blast
   * radius crosses a repo boundary indistinguishable from one with no
   * cross-repo consumers. Absent this marker a truncated run emits a
   * confident-looking `risk` byte-identical to a complete one.
   */
  riskEpistemic?: 'lower-bound';
  /**
   * Milliseconds budget applied to the **Phase 1 local impact** leg (`safeLocalImpact`).
   * If the walk hits this wall first, expect `truncationReason: 'timeout'` and a partial `local` payload.
   */
  timeoutMs?: number;
  /** Present when local impact or fan-out stopped early (timeout, graph cap, etc.). */
  truncationReason?: GroupImpactTruncationReason;
  /**
   * Human-readable note when `crossDepth` was clamped (e.g. multi-hop not implemented yet).
   */
  crossDepthWarning?: string;
}

/** One repo’s `context` tool payload in a group-scoped context run. */
export interface GroupContextRepoEntry {
  repoPath: string;
  registryName: string;
  payload: unknown;
}

/**
 * Aggregated group `context`: explicit per-repo rows (no merged symbol payloads).
 * Use top-level `error` only for unrecoverable failures, not for “no matches” or service scope misses.
 */
export interface GroupContextResult {
  group: string;
  target?: string;
  service?: string;
  error?: string;
  results: GroupContextRepoEntry[];
}

export interface CrossRepoImpact {
  repo: string;
  repo_path: string;
  contract: {
    id: string;
    type: ContractType;
    match_type: MatchType;
    confidence: number;
  };
  by_depth: Record<string, unknown[]>;
  affected_processes: string[];
  /**
   * Present when the bridge proves a repository boundary but the far endpoint
   * has no graph symbol, so local fan-out cannot be attempted. Omitted for
   * completed fan-out to preserve the existing serialized result shape.
   */
  fanout_status?: 'not_attempted';
}

export interface OutOfScopeLink {
  from: string;
  to: string;
  contractId: string;
  confidence: number;
}

/** Opaque handle to an open bridge LadybugDB. */
export interface BridgeHandle {
  /** Internal — do not access directly. */
  readonly _db: unknown;
  readonly _conn: unknown;
  readonly groupDir: string;
  /**
   * True when the handle was opened read-only. `closeBridgeDb` must NOT issue a
   * CHECKPOINT on a read-only connection — doing so leaves a WAL/shadow lock
   * artifact that makes the next read-only open of the same file fail in-process
   * (repeated `@group` impact/trace calls in a long-lived server).
   */
  readonly _readOnly?: boolean;
}

export interface BridgeMeta {
  version: number;
  generatedAt: string;
  /**
   * Size and mtime of the `bridge.lbug` this metadata was written for, so a
   * reader can tell whether the two still belong together.
   *
   * `writeBridge` replaces the database and writes this file as two operations;
   * a sync that stops between them leaves the PREVIOUS sync's metadata beside a
   * new database, and `runGroupImpact` reads completeness from that metadata.
   * Stamping the pair is what lets `bridgeMetaMatchesFile` reject the mismatch
   * without anything having to be deleted — deleting the old metadata up front
   * would lose it permanently on a swap that fails with the old database still
   * in place, which is a normal Windows outcome when a read-only handle is held.
   *
   * Optional: metadata written before this existed carries no stamp. Such a
   * file is not waved through — `bridgeMetaMatchesFile` falls back to comparing
   * the two files' modification times, since a successful write orders the
   * database rename before the metadata write and a database NEWER than the
   * metadata beside it therefore cannot be the one it describes.
   *
   * That fallback proves WRITE ORDER, not provenance, and is wrong in both
   * directions — a non-monotonic clock can make a mis-paired set read as
   * ordered, and any copy or restore that rewrites the database's times after
   * the metadata's demotes an intact legacy pair to a lower bound until the
   * next sync re-stamps it. A stamped pair never reaches that fallback, which
   * is the reason to prefer stamping over widening the heuristic. Both
   * directions are spelled out at `bridgeMetaMatchesFile`.
   */
  bridgeSize?: number;
  bridgeMtimeMs?: number;
  /**
   * Reader-side only: true when `meta.json` parsed but one of its repo lists
   * held a value that was not a list of repo paths.
   *
   * NEVER PERSISTED. `readBridgeMeta` sets it to describe what it found in the
   * file; `writeBridgeMeta`'s only caller builds a fresh literal, so it cannot
   * round-trip back to disk. It lives on this interface rather than on a
   * reader-only subtype so that `readBridgeMeta` keeps the exact signature
   * every caller already compiles against.
   *
   * The unusable value is dropped rather than normalized, so `missingRepos: []`
   * on such a result is inert filler — this flag, not the empty list, is what
   * says the bridge's provenance is unknown.
   */
  repoListsUnreadable?: boolean;
  /**
   * Reader-side only: did this metadata pair with the `bridge.lbug` beside it,
   * measured BEFORE anything opened that database?
   *
   * NEVER PERSISTED, for the same reason as `repoListsUnreadable`.
   *
   * The measurement has to happen before the open, and the answer has to be
   * carried rather than recomputed. `runGroupImpact` and `runGroupTrace` open
   * the bridge and only then ask about provenance, so a platform where a
   * read-only open advances the database's mtime would fail every unstamped
   * pair the moment it was read — turning back-compat for pre-stamp bridges
   * into a repo-wide "everything is a lower bound". Whether any given
   * LadybugDB build and OS does that is not something a reader should have to
   * know, and it cannot be observed on Windows, where the in-process
   * write→read reopen this would need is a documented limitation. Ordering the
   * check ahead of the open makes the question moot on every platform instead
   * of true on the ones that happen to be testable.
   */
  pairedWithDatabase?: boolean;
  /**
   * PERSISTED, unlike the two fields above: the writer of this metadata could
   * not establish that it describes the `bridge.lbug` beside it, and no reader
   * may conclude otherwise from the files alone.
   *
   * Written by `refreshPreservedBridgeMeta` — the preserve path in `syncGroup`,
   * which refreshes the diagnostic lists of a bridge it deliberately does NOT
   * rebuild. That refresh rewrites `meta.json` ATOMICALLY, so this file's mtime
   * becomes now while the database's stays old; and "metadata newer than the
   * database beside it" is exactly the write order that
   * `unstampedMetaPairsByWriteOrder` accepts. A refresh that simply carried the
   * old fields forward would therefore convert a pair that check had been
   * REJECTING into one it waves through — laundering unknown provenance into
   * verified provenance, which is the fail-open this whole channel exists to
   * close.
   *
   * "Just don't write a stamp" is not a substitute, and is worse: an unstamped
   * metadata file is judged on the two file times, and the refresh has already
   * moved them into the accepting order. The verdict has to be recorded IN the
   * file, because the write that records it is itself what destroys the
   * evidence a reader would otherwise use.
   *
   * `bridgeMetaMatchesFile` rejects on this ahead of both the stamp and the
   * write-order heuristic, so `ensureBridgeReady` answers
   * `pairedWithDatabase: false` and `bridgeProvenanceUnknown` reports the
   * cross-repo answer as a lower bound. That is the ONE enforcement point; do
   * not add a second reader for this field.
   *
   * Self-clearing: a successful `writeBridge` builds fresh metadata from a
   * literal and never sets it, so the next good sync retires the marker without
   * anything having to delete it.
   */
  provenanceUnknown?: boolean;
  missingRepos: string[];
  /**
   * Configured repos the sync that produced this bridge could not extract from
   * (see `ContractRegistry.unreadableRepos`). Their contracts and every
   * cross-link touching them are absent from `bridge.lbug`, so a cross-repo
   * impact query against this bridge is a lower bound, not a verdict —
   * `runGroupImpact` folds a non-empty value into its truncation fields for
   * exactly that reason.
   * Optional: a bridge written before this field existed does not record it.
   */
  unreadableRepos?: string[];
}
