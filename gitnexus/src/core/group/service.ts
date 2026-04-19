/**
 * Group orchestration shared by MCP (LocalBackend) and CLI.
 * DB access is injected via GroupToolPort so this module stays free of LocalBackend private API.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { checkStaleness } from '../git-staleness.js';
import { loadGroupConfig } from './config-parser.js';
import {
  fileMatchesServicePrefix,
  normalizeServicePrefix,
  repoInSubgroup,
} from './group-path-utils.js';
import { getDefaultGitnexusDir, getGroupDir, listGroups, readContractRegistry } from './storage.js';
import { syncGroup } from './sync.js';
import type {
  ContractRegistry,
  CrossLink,
  GroupConfig,
  GroupContextResult,
  StoredContract,
} from './types.js';

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
  context(
    repo: GroupRepoHandle,
    params: {
      name?: string;
      uid?: string;
      file_path?: string;
      include_content?: boolean;
    },
  ): Promise<unknown>;
}

function isStoredContract(raw: unknown): raw is StoredContract {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.contractId === 'string' &&
    typeof o.type === 'string' &&
    typeof o.repo === 'string' &&
    typeof o.role === 'string' &&
    (o.role === 'provider' || o.role === 'consumer') &&
    typeof o.symbolUid === 'string' &&
    typeof o.symbolName === 'string' &&
    typeof o.confidence === 'number' &&
    o.meta !== undefined &&
    typeof o.meta === 'object' &&
    o.meta !== null &&
    o.symbolRef !== undefined &&
    typeof o.symbolRef === 'object' &&
    o.symbolRef !== null &&
    typeof (o.symbolRef as Record<string, unknown>).filePath === 'string' &&
    typeof (o.symbolRef as Record<string, unknown>).name === 'string'
  );
}

function filterQueryByServicePrefix(
  queryResult: {
    processes?: Array<Record<string, unknown>>;
    process_symbols?: Array<Record<string, unknown>>;
  },
  servicePrefix: string,
): { processes: Array<Record<string, unknown>>; process_symbols: Array<Record<string, unknown>> } {
  const symbols = (queryResult.process_symbols || []).filter((s) =>
    fileMatchesServicePrefix(
      typeof s.filePath === 'string' ? s.filePath : undefined,
      servicePrefix,
    ),
  );
  const allowed = new Set(
    symbols.map((s) => String((s as { process_id?: string }).process_id ?? '')).filter(Boolean),
  );
  const processes = (queryResult.processes || []).filter((p) => allowed.has(String(p.id)));
  return { processes, process_symbols: symbols };
}

function isCrossLink(raw: unknown): raw is CrossLink {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  const from = o.from as Record<string, unknown> | undefined;
  const to = o.to as Record<string, unknown> | undefined;
  if (!from || !to) return false;
  if (typeof from.repo !== 'string' || typeof to.repo !== 'string') return false;
  return typeof o.contractId === 'string' && typeof o.type === 'string';
}

async function loadContractRegistryResilient(
  groupDir: string,
): Promise<
  { ok: true; registry: ContractRegistry; skippedCorrupt: number } | { ok: false; error: string }
> {
  const filePath = path.join(groupDir, 'contracts.json');
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `No contracts.json for this group. Run group_sync first.` };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'contracts.json is not valid JSON' };
  }

  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, error: 'contracts.json has an invalid root object' };
  }

  const base = root as Record<string, unknown>;
  const contractsRaw = base.contracts;
  const crossRaw = base.crossLinks;
  let skippedCorrupt = 0;

  const contracts: StoredContract[] = [];
  if (Array.isArray(contractsRaw)) {
    for (const row of contractsRaw) {
      try {
        if (isStoredContract(row)) {
          contracts.push(row);
        } else {
          skippedCorrupt++;
          console.warn('[group] skipping corrupt contract row in contracts.json');
        }
      } catch {
        skippedCorrupt++;
        console.warn('[group] skipping corrupt contract row in contracts.json');
      }
    }
  }

  const crossLinks: CrossLink[] = [];
  if (Array.isArray(crossRaw)) {
    for (const row of crossRaw) {
      try {
        if (isCrossLink(row)) {
          crossLinks.push(row);
        } else {
          skippedCorrupt++;
          console.warn('[group] skipping corrupt crossLinks row in contracts.json');
        }
      } catch {
        skippedCorrupt++;
        console.warn('[group] skipping corrupt crossLinks row in contracts.json');
      }
    }
  }

  const registry: ContractRegistry = {
    version: typeof base.version === 'number' ? base.version : 0,
    generatedAt: typeof base.generatedAt === 'string' ? base.generatedAt : '',
    repoSnapshots:
      base.repoSnapshots && typeof base.repoSnapshots === 'object' && base.repoSnapshots !== null
        ? (base.repoSnapshots as Record<string, { indexedAt: string; lastCommit: string }>)
        : {},
    missingRepos: Array.isArray(base.missingRepos) ? (base.missingRepos as string[]) : [],
    contracts,
    crossLinks,
  };

  return { ok: true, registry, skippedCorrupt };
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
    const loaded = await loadContractRegistryResilient(groupDir);
    if (loaded.ok === false) {
      if (loaded.error.includes('No contracts.json')) {
        return { error: `No contracts.json for group "${name}". Run group_sync first.` };
      }
      return { error: loaded.error };
    }
    const { registry, skippedCorrupt } = loaded;
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
    const out: Record<string, unknown> = { contracts, crossLinks: registry.crossLinks };
    if (skippedCorrupt > 0) out.skippedCorrupt = skippedCorrupt;
    return out;
  }

  async groupImpact(params: Record<string, unknown>): Promise<unknown> {
    const { runGroupImpact } = await import('./cross-impact.js');
    return runGroupImpact({ port: this.port, gitnexusDir: getDefaultGitnexusDir() }, params);
  }

  async groupContext(params: Record<string, unknown>): Promise<GroupContextResult> {
    const name = String(params.name ?? '').trim();
    const target = typeof params.target === 'string' ? params.target.trim() : '';
    const uid = typeof params.uid === 'string' ? params.uid.trim() : undefined;
    const file_path = typeof params.file_path === 'string' ? params.file_path : undefined;
    const include_content = Boolean(params.include_content);
    if (
      params.service !== undefined &&
      params.service !== null &&
      String(params.service).trim() === ''
    ) {
      return { group: name || '', error: 'service must not be an empty string', results: [] };
    }
    const servicePrefix = normalizeServicePrefix(params.service);
    const subgroup = typeof params.subgroup === 'string' ? params.subgroup : undefined;
    const subgroupExact = params.subgroupExact === true;

    if (!name) {
      return { group: '', error: 'name is required', results: [] };
    }
    if (!uid && !target) {
      return { group: name, error: 'target or uid is required', results: [] };
    }

    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    let config: GroupConfig;
    try {
      config = await loadGroupConfig(groupDir);
    } catch (e) {
      return {
        group: name,
        target: target || uid,
        service: servicePrefix,
        error: e instanceof Error ? e.message : String(e),
        results: [],
      };
    }

    const memberEntries = Object.entries(config.repos).filter(([repoPath]) =>
      repoInSubgroup(repoPath, subgroup, subgroupExact),
    );

    // Per-repo work is independent (each repo opens its own DB handle and the
    // group-level result preserves repo iteration order via the indexed map).
    // Errors are caught per repo so one slow/failed member does not block the rest.
    const results: GroupContextResult['results'] = await Promise.all(
      memberEntries.map(async ([repoPath, registryName]) => {
        try {
          const repoObj = await this.port.resolveRepo(registryName);
          const payload = await this.port.context(repoObj, {
            name: target || undefined,
            uid,
            file_path,
            include_content,
          });

          if (servicePrefix) {
            const st = (payload as { status?: string })?.status;
            const sym = (payload as { symbol?: { filePath?: string } })?.symbol;
            if (st === 'found' && !fileMatchesServicePrefix(sym?.filePath, servicePrefix)) {
              return { repoPath, registryName, payload: {} };
            }
          }

          return { repoPath, registryName, payload };
        } catch (e) {
          return {
            repoPath,
            registryName,
            payload: { error: e instanceof Error ? e.message : String(e) },
          };
        }
      }),
    );

    return {
      group: name,
      target: target || uid,
      service: servicePrefix,
      results,
    };
  }

  async groupQuery(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    const queryText = String(params.query ?? '').trim();
    if (!name || !queryText) return { error: 'name and query are required' };
    if (
      params.service !== undefined &&
      params.service !== null &&
      String(params.service).trim() === ''
    ) {
      return { error: 'service must not be an empty string' };
    }
    const servicePrefix = normalizeServicePrefix(params.service);

    const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 5;
    const subgroup = typeof params.subgroup === 'string' ? params.subgroup : undefined;
    const subgroupExact = params.subgroupExact === true;
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    const config = await loadGroupConfig(groupDir);

    const memberEntries = Object.entries(config.repos).filter(([repoPath]) =>
      repoInSubgroup(repoPath, subgroup, subgroupExact),
    );

    // Per-repo query is independent; run them concurrently and isolate
    // failures so one slow/failed member does not block the rest.
    const perRepo = await Promise.all(
      memberEntries.map(async ([repoPath, registryName]) => {
        try {
          const repoObj = await this.port.resolveRepo(registryName);
          const queryResult = (await this.port.query(repoObj, {
            query: queryText,
            limit,
            max_symbols: 10,
            include_content: false,
          })) as {
            processes?: Array<Record<string, unknown>>;
            process_symbols?: Array<Record<string, unknown>>;
          };
          const processes = servicePrefix
            ? filterQueryByServicePrefix(queryResult, servicePrefix).processes
            : queryResult.processes || [];
          const scored = processes.map((p, idx) => ({
            ...p,
            _rrf_score: 1 / (idx + 1 + 60),
            _repo: repoPath,
          }));
          return { repo: repoPath, score: 0, processes: scored as unknown[] };
        } catch {
          return { repo: repoPath, score: 0, processes: [] as unknown[] };
        }
      }),
    );

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

    for (const [repoPath, registryName] of Object.entries(config.repos)) {
      try {
        const repoObj = await this.port.resolveRepo(registryName);
        const metaPath = path.join(repoObj.storagePath, 'meta.json');
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
