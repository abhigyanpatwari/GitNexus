export interface RepoStats {
  files?: number;
  nodes?: number;
  processes?: number;
  communities?: number;
}

export interface RepoRegistryEntry {
  name: string;
  path: string;
  storagePath?: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RepoStats;
}

export interface ModuleSummary {
  name: string;
  symbols: number;
  cohesion?: string;
}

export interface ProcessSummary {
  name: string;
  type: string;
  steps: number;
}

export interface WorkspaceIndexStatus {
  state: 'fresh' | 'stale' | 'not-indexed';
  repo?: RepoRegistryEntry;
  currentCommit?: string;
}
