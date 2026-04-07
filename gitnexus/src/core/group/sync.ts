import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { initLbug, closeLbug, executeParameterized } from '../lbug/pool-adapter.js';
import { readRegistry, type RegistryEntry } from '../../storage/repo-manager.js';
import type { GroupConfig, RepoHandle, RepoSnapshot, StoredContract, CrossLink } from './types.js';
import { HttpRouteExtractor } from './extractors/http-route-extractor.js';
import { GrpcExtractor } from './extractors/grpc-extractor.js';
import { TopicExtractor } from './extractors/topic-extractor.js';
import { runExactMatch } from './matching.js';
import { applyHttpMappings } from './http-mapping.js';
import { detectServiceBoundaries, assignService } from './service-boundary-detector.js';
import type { CypherExecutor } from './contract-extractor.js';
import { writeContractRegistry } from './storage.js';
import type { ContractRegistry } from './types.js';

function matchedContractKey(repo: string, contractId: string): string {
  return `${repo}::${contractId}`;
}

export interface SyncOptions {
  extractorOverride?:
    | ((repo: RepoHandle) => Promise<StoredContract[]>)
    | (() => Promise<StoredContract[]>);
  resolveRepoHandle?: (registryName: string, groupPath: string) => Promise<RepoHandle | null>;
  skipWrite?: boolean;
  groupDir?: string;
  allowStale?: boolean;
  verbose?: boolean;
  exactOnly?: boolean;
  skipEmbeddings?: boolean;
}

export interface SyncResult {
  contracts: StoredContract[];
  crossLinks: CrossLink[];
  unmatched: StoredContract[];
  missingRepos: string[];
  repoSnapshots: Record<string, RepoSnapshot>;
}

export function stableRepoPoolId(entry: RegistryEntry, allEntries: RegistryEntry[]): string {
  const base = entry.name.toLowerCase();
  const resolved = path.resolve(entry.path);
  for (const other of allEntries) {
    if (other.name.toLowerCase() === base && path.resolve(other.path) !== resolved) {
      const hash = Buffer.from(entry.path).toString('base64url').slice(0, 6);
      return `${base}-${hash}`;
    }
  }
  return base;
}

function defaultResolveHandle(allEntries: RegistryEntry[]) {
  return async (registryName: string, groupPath: string): Promise<RepoHandle | null> => {
    const e = allEntries.find((en) => en.name === registryName);
    if (!e) return null;
    const poolId = stableRepoPoolId(e, allEntries);
    return {
      id: poolId,
      path: groupPath,
      repoPath: e.path,
      storagePath: e.storagePath,
    };
  };
}

export async function syncGroup(config: GroupConfig, opts?: SyncOptions): Promise<SyncResult> {
  const missingRepos: string[] = [];
  const repoSnapshots: Record<string, RepoSnapshot> = {};
  let autoContracts: StoredContract[] = [];
  let dbExecutors: Map<string, CypherExecutor> | undefined;

  const eo = opts?.extractorOverride;
  if (eo && eo.length === 0) {
    autoContracts = await (eo as () => Promise<StoredContract[]>)();
  } else {
    const entries = await readRegistry();
    const resolve = opts?.resolveRepoHandle ?? defaultResolveHandle(entries);
    const httpEx = new HttpRouteExtractor();
    const grpcEx = new GrpcExtractor();
    const topicEx = new TopicExtractor();
    dbExecutors = new Map<string, CypherExecutor>();
    const openPoolIds: string[] = [];

    try {
      for (const [groupPath, regName] of Object.entries(config.repos)) {
        const handle = await resolve(regName, groupPath);
        if (!handle) {
          missingRepos.push(groupPath);
          continue;
        }

        const poolId = handle.id;
        const lbugPath = path.join(handle.storagePath, 'lbug');
        try {
          await initLbug(poolId, lbugPath);
          openPoolIds.push(poolId);

          const executor: CypherExecutor = (query, params) =>
            executeParameterized(poolId, query, params ?? {});

          dbExecutors.set(groupPath, executor);

          const boundaries = await detectServiceBoundaries(handle.repoPath);

          if (config.detect.http) {
            const extracted = await httpEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.grpc) {
            const extracted = await grpcEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.topics) {
            const extracted = await topicEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          const metaPath = path.join(handle.storagePath, 'meta.json');
          try {
            const raw = await fs.readFile(metaPath, 'utf-8');
            const m = JSON.parse(raw) as { indexedAt?: string; lastCommit?: string };
            repoSnapshots[groupPath] = {
              indexedAt: m.indexedAt || '',
              lastCommit: m.lastCommit || '',
            };
          } catch {
            const e = entries.find((en) => en.name === regName);
            repoSnapshots[groupPath] = {
              indexedAt: e?.indexedAt || '',
              lastCommit: e?.lastCommit || '',
            };
          }
        } catch {
          missingRepos.push(groupPath);
        }
      }
    } finally {
      for (const id of [...new Set(openPoolIds)]) {
        await closeLbug(id).catch(() => {});
      }
    }
  }

  const manifestMatches = applyHttpMappings(autoContracts, config.httpMappings);
  const exactContracts = autoContracts.filter(
    (contract) =>
      !(
        contract.role === 'consumer' &&
        manifestMatches.matchedConsumerIds.has(matchedContractKey(contract.repo, contract.contractId))
      ),
  );
  const exactMatches = runExactMatch(exactContracts);
  const crossLinks: CrossLink[] = [...manifestMatches.matched, ...exactMatches.matched];
  const allContracts: StoredContract[] = autoContracts;
  const matchedIds = new Set(
    crossLinks.flatMap((link) => [
      matchedContractKey(link.from.repo, link.fromContractId ?? link.contractId),
      matchedContractKey(link.to.repo, link.toContractId ?? link.contractId),
    ]),
  );
  const unmatched = allContracts.filter(
    (contract) => !matchedIds.has(matchedContractKey(contract.repo, contract.contractId)),
  );

  const registry: ContractRegistry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoSnapshots,
    missingRepos,
    contracts: allContracts,
    crossLinks,
  };

  if (opts?.groupDir && !opts.skipWrite) {
    await writeContractRegistry(opts.groupDir, registry);
  }

  return {
    contracts: allContracts,
    crossLinks,
    unmatched,
    missingRepos,
    repoSnapshots,
  };
}
