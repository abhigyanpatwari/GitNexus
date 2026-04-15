export type ContractType = 'http' | 'grpc' | 'topic' | 'lib' | 'custom';
export type MatchType = 'exact' | 'manifest' | 'wildcard' | 'bm25' | 'embedding';
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
  topics: boolean;
  shared_libs: boolean;
  embedding_fallback: boolean;
}

export interface MatchingConfig {
  bm25_threshold: number;
  embedding_threshold: number;
  max_candidates_per_step: number;
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
  missingRepos: string[];
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

/** Why local impact or fan-out stopped early (e.g. wall-clock budget exhausted). */
export type GroupImpactTruncationReason = 'timeout' | 'partial';

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
}

export interface BridgeMeta {
  version: number;
  generatedAt: string;
  missingRepos: string[];
}
