/**
 * Cross-repo group orchestration shared by MCP (LocalBackend) and CLI.
 * DB access is injected via GroupToolPort so this module stays free of LocalBackend private API.
 */

import { checkStaleness } from '../git-staleness.js';
import { loadGroupConfig } from './config-parser.js';
import { runGroupImpact } from './cross-impact.js';
import { getDefaultGitnexusDir, getGroupDir, listGroups, readContractRegistry } from './storage.js';
import { syncGroup } from './sync.js';

export interface GroupRepoHandle {
  id: string;
  name: string;
  repoPath: string;
  storagePath: string;
  indexedAt?: string;
  lastCommit?: string;
}

export interface GroupToolPort {
  resolveRepo(repoParam?: string): Promise<GroupRepoHandle>;
  impact(
    repo: GroupRepoHandle,
    params: {
      target: string;
      direction: 'upstream' | 'downstream';
      maxDepth?: number;
      relationTypes?: string[];
      includeTests?: boolean;
      minConfidence?: number;
    },
  ): Promise<unknown>;
  query(
    repo: GroupRepoHandle,
    params: {
      query: string;
      task_context?: string;
      goal?: string;
      limit?: number;
      max_symbols?: number;
      include_content?: boolean;
    },
  ): Promise<unknown>;
  impactByUid(
    repoId: string,
    uid: string,
    direction: string,
    opts: {
      maxDepth: number;
      relationTypes: string[];
      minConfidence: number;
      includeTests: boolean;
    },
  ): Promise<unknown | null>;
}

function repoInSubgroup(repoPath: string, subgroup?: string): boolean {
  if (!subgroup?.trim()) return true;
  const s = subgroup.replace(/\/+$/, '');
  return repoPath === s || repoPath.startsWith(`${s}/`);
}

export class GroupService {
  constructor(private readonly port: GroupToolPort) {}

  async groupList(params: Record<string, unknown>): Promise<unknown> {
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    if (!name) {
      const groups = await listGroups();
      return { groups };
    }
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    const config = await loadGroupConfig(groupDir);
    return {
      name: config.name,
      description: config.description,
      repos: config.repos,
      links: config.links,
    };
  }

  async groupSync(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    if (!name) return { error: 'name is required' };
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    const config = await loadGroupConfig(groupDir);
    const result = await syncGroup(config, {
      groupDir,
      exactOnly: Boolean(params.exactOnly),
      skipEmbeddings: Boolean(params.skipEmbeddings),
      allowStale: Boolean(params.allowStale),
      verbose: Boolean(params.verbose),
    });
    return {
      contracts: result.contracts.length,
      crossLinks: result.crossLinks.length,
      unmatched: result.unmatched.length,
      missingRepos: result.missingRepos,
    };
  }

  async groupContracts(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    if (!name) return { error: 'name is required' };
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    const registry = await readContractRegistry(groupDir);
    if (!registry) {
      return { error: `No contracts.json for group "${name}". Run group_sync first.` };
    }
    let contracts = registry.contracts;
    if (params.type) contracts = contracts.filter((c) => c.type === params.type);
    if (params.repo) contracts = contracts.filter((c) => c.repo === params.repo);
    if (params.unmatchedOnly) {
      const matchedIds = new Set(
        registry.crossLinks.flatMap((l) => [
          `${l.from.repo}::${l.contractId}`,
          `${l.to.repo}::${l.contractId}`,
        ]),
      );
      contracts = contracts.filter((c) => !matchedIds.has(`${c.repo}::${c.contractId}`));
    }
    return { contracts, crossLinks: registry.crossLinks };
  }

  async groupImpact(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    const targetSymbol = String(params.target ?? '').trim();
    const repoGroupPath = String(params.repo ?? '').trim();
    if (!name || !targetSymbol || !repoGroupPath) {
      return { error: 'name, target, and repo are required' };
    }

    const direction = (params.direction as string) === 'downstream' ? 'downstream' : 'upstream';
    const maxDepth =
      typeof params.maxDepth === 'number' && Number.isFinite(params.maxDepth) ? params.maxDepth : 3;
    const minConfidence =
      typeof params.minConfidence === 'number' && Number.isFinite(params.minConfidence)
        ? params.minConfidence
        : 0.5;
    const timeout =
      typeof params.timeout === 'number' && Number.isFinite(params.timeout)
        ? params.timeout
        : 30000;
    const subgroup = typeof params.subgroup === 'string' ? params.subgroup : undefined;
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);

    const config = await loadGroupConfig(groupDir);
    const registry = await readContractRegistry(groupDir);
    if (!registry) {
      return { error: `No contracts.json for group "${name}". Run group_sync first.` };
    }

    const requestedCrossDepth =
      typeof params.crossDepth === 'number' && Number.isFinite(params.crossDepth)
        ? params.crossDepth
        : 1;
    const crossDepth = Math.min(requestedCrossDepth, 1);
    const crossDepthWarning =
      requestedCrossDepth > 1
        ? `Multi-hop cross-boundary traversal is not yet implemented. Using --cross-depth 1 (requested: ${requestedCrossDepth}).`
        : undefined;

    const defaultRelTypes = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];

    const resolveGroupRepo = async (groupPath: string): Promise<GroupRepoHandle> => {
      const registryName = config.repos[groupPath];
      if (!registryName) throw new Error(`Repo "${groupPath}" not found in group "${name}"`);
      return this.port.resolveRepo(registryName);
    };

    const result = await runGroupImpact({
      groupName: name,
      target: targetSymbol,
      repoPath: repoGroupPath,
      direction,
      registry,
      localImpactFn: async (t: string, d: string) => {
        const repoObj = await resolveGroupRepo(repoGroupPath);
        return this.port.impact(repoObj, {
          target: t,
          direction: d as 'upstream' | 'downstream',
          maxDepth,
          relationTypes: defaultRelTypes,
          minConfidence: 0,
          includeTests: false,
        });
      },
      crossImpactFn: async (targetGroupPath: string, uid: string, d: string) => {
        const registryName = config.repos[targetGroupPath];
        if (!registryName) return null;
        try {
          const repoObj = await this.port.resolveRepo(registryName);
          return this.port.impactByUid(repoObj.id, uid, d, {
            maxDepth,
            relationTypes: defaultRelTypes,
            minConfidence: 0,
            includeTests: false,
          });
        } catch {
          return null;
        }
      },
      maxDepth,
      minConfidence,
      subgroup,
      timeout,
      crossDepth,
    });

    if (crossDepthWarning) {
      (result as unknown as Record<string, unknown>).crossDepthWarning = crossDepthWarning;
    }

    return result;
  }

  async groupQuery(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    const queryText = String(params.query ?? '').trim();
    if (!name || !queryText) return { error: 'name and query are required' };

    const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 5;
    const subgroup = typeof params.subgroup === 'string' ? params.subgroup : undefined;
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    const config = await loadGroupConfig(groupDir);

    const perRepo: Array<{ repo: string; score: number; processes: unknown[] }> = [];
    for (const [repoPath, registryName] of Object.entries(config.repos)) {
      if (!repoInSubgroup(repoPath, subgroup)) continue;
      try {
        const repoObj = await this.port.resolveRepo(registryName);
        const queryResult = (await this.port.query(repoObj, {
          query: queryText,
          limit,
          max_symbols: 10,
          include_content: false,
        })) as { processes?: Array<Record<string, unknown>> };
        const processes = queryResult.processes || [];
        const scored = processes.map((p, idx) => ({
          ...p,
          _rrf_score: 1 / (idx + 1 + 60),
          _repo: repoPath,
        }));
        perRepo.push({ repo: repoPath, score: 0, processes: scored });
      } catch {
        perRepo.push({ repo: repoPath, score: 0, processes: [] });
      }
    }

    const allProcesses = perRepo.flatMap((r) => r.processes as Array<Record<string, unknown>>);
    allProcesses.sort((a, b) => (b._rrf_score as number) - (a._rrf_score as number));
    const topN = allProcesses.slice(0, limit);

    return {
      group: name,
      query: queryText,
      results: topN,
      per_repo: perRepo.map((r) => ({ repo: r.repo, count: r.processes.length })),
    };
  }

  async groupStatus(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    if (!name) return { error: 'name is required' };
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    const config = await loadGroupConfig(groupDir);
    const registry = await readContractRegistry(groupDir);

    const repoStatuses: Record<
      string,
      {
        indexStale: boolean;
        contractsStale: boolean;
        missing: boolean;
        commitsBehind?: number;
      }
    > = {};

    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');

    for (const [repoPath, registryName] of Object.entries(config.repos)) {
      try {
        const repoObj = await this.port.resolveRepo(registryName);
        const metaPath = pathMod.join(repoObj.storagePath, 'meta.json');
        const metaRaw = await fsp.readFile(metaPath, 'utf-8').catch(() => '{}');
        const meta = JSON.parse(metaRaw) as { lastCommit?: string; indexedAt?: string };

        const staleness = meta.lastCommit
          ? checkStaleness(repoObj.repoPath, meta.lastCommit)
          : { isStale: true, commitsBehind: -1 };

        const snapshot = registry?.repoSnapshots[repoPath];
        const contractsStale =
          snapshot && meta.indexedAt ? snapshot.indexedAt !== meta.indexedAt : !snapshot;

        repoStatuses[repoPath] = {
          indexStale: staleness.isStale,
          contractsStale: Boolean(contractsStale),
          missing: false,
          commitsBehind: staleness.commitsBehind,
        };
      } catch {
        repoStatuses[repoPath] = { indexStale: false, contractsStale: false, missing: true };
      }
    }

    return {
      group: name,
      lastSync: registry?.generatedAt || null,
      missingRepos: registry?.missingRepos || [],
      repos: repoStatuses,
    };
  }
}
