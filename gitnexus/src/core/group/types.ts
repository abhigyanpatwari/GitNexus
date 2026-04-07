export type ContractType = 'http' | 'grpc' | 'topic' | 'lib' | 'custom';
export type MatchType = 'exact' | 'manifest' | 'bm25' | 'embedding';
export type ContractRole = 'provider' | 'consumer';

export interface GroupConfig {
  version: number;
  name: string;
  description: string;
  repos: Record<string, string>;
  links: GroupManifestLink[];
  httpMappings: HttpMappingRule[];
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

export interface HttpMappingTarget {
  repo: string;
  service?: string;
}

export interface HttpMappingRule {
  from: string;
  to: HttpMappingTarget;
  methods?: string[];
  match: string;
  rewrite: string;
  when?: Record<string, string>;
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
  fromContractId?: string;
  toContractId?: string;
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
