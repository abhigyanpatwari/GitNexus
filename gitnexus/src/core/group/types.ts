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

export type TruncationReason = 'phase1_timeout' | 'wall_deadline';

export interface GroupImpactResult {
  local: unknown;
  group: string;
  cross: CrossRepoImpact[];
  outOfScope: OutOfScopeLink[];
  truncated: boolean;
  truncatedRepos: string[];
  /**
   * Why the result is partial. Absent when `truncated` is false.
   * - `phase1_timeout` — local impact walk hit the Phase-1 timeout; Phase-2
   *   continued with empty local seed, so cross-repo fanout is almost certainly
   *   empty. Local stub fields (`impactedCount: 0`, `risk: 'LOW'`, `byDepth: {}`)
   *   are placeholders, NOT real zero-impact results.
   * - `wall_deadline` — Phase-2 ran out of wall-clock time while iterating
   *   cross-link candidates; some results may be present but more could exist.
   */
  truncationReason?: TruncationReason;
  /**
   * Populated when the caller requested a crossDepth greater than the
   * MVP-supported max (currently 1). The traversal still runs at the
   * supported depth, but the warning is echoed back so the caller (CLI,
   * MCP, test) can surface it to the user.
   */
  crossDepthWarning?: string;
  summary: {
    direct: number;
    processes_affected: number;
    modules_affected: number;
    cross_repo_hits: number;
  };
  risk: string;
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
  matchType: MatchType;
  confidence: number;
}

/**
 * @deprecated Use bridge.lbug instead. Kept for JSON fallback during migration.
 * This is a type alias — ContractRegistry is NOT removed yet.
 * In Task 10 (cleanup), ContractRegistry will be renamed to LegacyContractRegistry
 * and all imports updated. For now, both names work.
 */
export type LegacyContractRegistry = ContractRegistry;

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
