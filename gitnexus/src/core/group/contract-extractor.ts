import type { ContractType, ExtractedContract, RepoHandle } from './types.js';

export interface ContractExtractor {
  type: ContractType;
  canExtract(repo: RepoHandle): Promise<boolean>;
  extract(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    repo: RepoHandle,
  ): Promise<ExtractedContract[]>;
}

export type CypherExecutor = (
  query: string,
  params?: Record<string, unknown>,
) => Promise<Record<string, unknown>[]>;
