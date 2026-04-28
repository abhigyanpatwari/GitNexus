/**
 * Group orchestration shared by MCP (LocalBackend) and CLI.
 * DB access is injected via GroupToolPort so this module stays free of LocalBackend private API.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { checkStaleness } from '../git-staleness.js';
import { GroupNotFoundError, loadGroupConfig } from './config-parser.js';
import { readNpmManifest } from './extractors/manifest-reader.js';
import {
  fileMatchesServicePrefix,
  normalizeServicePrefix,
  repoInSubgroup,
} from './group-path-utils.js';
import {
  createGroupDir,
  getDefaultGitnexusDir,
  getGroupDir,
  listGroups,
  readContractRegistry,
} from './storage.js';
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
  impact(repo: GroupRepoHandle, params: Record<string, unknown>): Promise<unknown>;
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
    let config: GroupConfig;
    try {
      config = await loadGroupConfig(groupDir);
    } catch (err) {
      if (err instanceof GroupNotFoundError)
        return { error: `Group "${name}" not found. Run group_list to see configured groups.` };
      throw err;
    }
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
    let config: GroupConfig;
    try {
      config = await loadGroupConfig(groupDir);
    } catch (err) {
      if (err instanceof GroupNotFoundError)
        return { error: `Group "${name}" not found. Run group_list to see configured groups.` };
      throw err;
    }
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
      if (e instanceof GroupNotFoundError)
        return {
          group: name,
          target: target || uid,
          service: servicePrefix,
          error: `Group "${name}" not found. Run group_list to see configured groups.`,
          results: [],
        };
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
    let config: GroupConfig;
    try {
      config = await loadGroupConfig(groupDir);
    } catch (err) {
      if (err instanceof GroupNotFoundError)
        return { error: `Group "${name}" not found. Run group_list to see configured groups.` };
      throw err;
    }

    const memberEntries = Object.entries(config.repos).filter(([repoPath]) =>
      repoInSubgroup(repoPath, subgroup, subgroupExact),
    );

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
    let config: GroupConfig;
    try {
      config = await loadGroupConfig(groupDir);
    } catch (err) {
      if (err instanceof GroupNotFoundError)
        return { error: `Group "${name}" not found. Run group_list to see configured groups.` };
      throw err;
    }
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

  /**
   * Traverse the cross-repo knowledge graph for a symbol.
   * Returns the symbol's local context plus all cross-repo connections via CrossLinks.
   */
  async groupGraph(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    const symbol = String(params.symbol ?? '').trim();
    const repoParam = typeof params.repo === 'string' ? params.repo.trim() : undefined;
    const depth = typeof params.depth === 'number' ? Math.min(params.depth, 2) : 1;
    const direction = typeof params.direction === 'string' ? params.direction : 'both';

    if (!name || !symbol) return { error: 'name and symbol are required' };

    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    const config = await loadGroupConfig(groupDir);
    const registry = await readContractRegistry(groupDir);

    if (!registry) {
      return { error: `No contracts.json for group "${name}". Run group_sync first.` };
    }

    // Find the symbol in a repo
    let sourceRepo: GroupRepoHandle | null = null;
    let localContext: unknown = null;

    if (repoParam) {
      // User specified which repo
      try {
        sourceRepo = await this.port.resolveRepo(repoParam);
        localContext = await this.port.query(sourceRepo, {
          query: symbol,
          limit: 5,
          max_symbols: 10,
          include_content: false,
        });
      } catch {
        return { error: `Cannot resolve repo: ${repoParam}` };
      }
    } else {
      // Search all repos in the group for the symbol
      for (const [, registryName] of Object.entries(config.repos)) {
        try {
          const repo = await this.port.resolveRepo(registryName);
          const result = await this.port.query(repo, {
            query: symbol,
            limit: 3,
            max_symbols: 5,
            include_content: false,
          });
          const processes = (result as { processes?: unknown[] }).processes || [];
          if (processes.length > 0) {
            sourceRepo = repo;
            localContext = result;
            break;
          }
        } catch {
          // Skip inaccessible repos
        }
      }
    }

    if (!sourceRepo) {
      return { error: `Symbol "${symbol}" not found in any repo in group "${name}"` };
    }

    // Find cross-repo connections via CrossLinks
    const crossConnections: Array<{
      direction: 'outgoing' | 'incoming';
      link: (typeof registry.crossLinks)[0];
      remoteRepo: string;
      remoteContext: unknown;
    }> = [];

    const visited = new Set<string>([sourceRepo.name]);

    const findConnections = async (repoName: string, currentDepth: number): Promise<void> => {
      if (currentDepth > depth) return;

      for (const link of registry.crossLinks) {
        const isFrom =
          link.from.repo === repoName ||
          Object.entries(config.repos).some(([gp, rn]) => gp === link.from.repo && rn === repoName);
        const isTo =
          link.to.repo === repoName ||
          Object.entries(config.repos).some(([gp, rn]) => gp === link.to.repo && rn === repoName);

        let remoteRepoGroupPath: string | null = null;
        let linkDirection: 'outgoing' | 'incoming' | null = null;

        if (isFrom && (direction === 'downstream' || direction === 'both')) {
          remoteRepoGroupPath = link.to.repo;
          linkDirection = 'outgoing';
        } else if (isTo && (direction === 'upstream' || direction === 'both')) {
          remoteRepoGroupPath = link.from.repo;
          linkDirection = 'incoming';
        }

        if (!remoteRepoGroupPath || !linkDirection) continue;

        // Find registry name for remote repo
        const remoteRegistryName = config.repos[remoteRepoGroupPath];
        if (!remoteRegistryName || visited.has(remoteRegistryName)) continue;
        visited.add(remoteRegistryName);

        let remoteContext: unknown = null;
        try {
          const remoteRepo = await this.port.resolveRepo(remoteRegistryName);
          // Get context for the connected symbol
          const remoteSymbol =
            linkDirection === 'outgoing' ? link.to.symbolRef.name : link.from.symbolRef.name;
          remoteContext = await this.port.query(remoteRepo, {
            query: remoteSymbol,
            limit: 3,
            max_symbols: 5,
            include_content: false,
          });
        } catch {
          // Remote repo not accessible
        }

        crossConnections.push({
          direction: linkDirection,
          link,
          remoteRepo: remoteRepoGroupPath,
          remoteContext,
        });

        // Recurse into the remote repo so depth > 1 actually traverses further.
        // `visited` (closed over above) prevents cycles.
        await findConnections(remoteRegistryName, currentDepth + 1);
      }
    };

    // Find connections from source repo
    const sourceGroupPath =
      Object.entries(config.repos).find(([, rn]) => rn === sourceRepo!.name)?.[0] ||
      sourceRepo.name;
    await findConnections(sourceGroupPath, 1);

    return {
      group: name,
      symbol,
      sourceRepo: sourceRepo.name,
      localContext,
      crossConnections: crossConnections.map((cc) => ({
        direction: cc.direction,
        remoteRepo: cc.remoteRepo,
        contractId: cc.link.contractId,
        contractType: cc.link.type,
        matchType: cc.link.matchType,
        confidence: cc.link.confidence,
        from: cc.link.from,
        to: cc.link.to,
        remoteContext: cc.remoteContext,
      })),
      totalCrossLinks: crossConnections.length,
    };
  }

  /**
   * Auto-discover indexed repos in a directory and create a group with code-level dependency detection.
   */
  async groupDiscover(params: Record<string, unknown>): Promise<unknown> {
    const directory = typeof params.directory === 'string' ? params.directory.trim() : '';
    const repoPaths = Array.isArray(params.repoPaths) ? (params.repoPaths as string[]) : [];
    const groupName = typeof params.name === 'string' ? params.name.trim() : 'workspace';
    const force = Boolean(params.force);
    const skipSync = Boolean(params.skipSync);

    if (!directory && repoPaths.length === 0)
      return { error: 'directory or repoPaths is required' };

    const repos: Record<string, string> = {};
    const packages: Record<string, Record<string, string>> = {};
    const discoveredRepos: Array<{
      name: string;
      path: string;
      packageName: string | null;
    }> = [];

    if (repoPaths.length > 0) {
      // Explicit repo paths mode
      for (const repoPath of repoPaths) {
        const resolvedPath = path.resolve(repoPath);
        const metaPath = path.join(resolvedPath, '.gitnexus', 'meta.json');

        let metaExists = false;
        try {
          await fsp.access(metaPath);
          metaExists = true;
        } catch {
          // Not indexed
        }
        if (!metaExists) {
          return {
            error: `Repo at ${resolvedPath} is not indexed. Run 'gitnexus analyze' there first.`,
          };
        }

        const dirName = path.basename(resolvedPath);
        let registryName: string | null = null;
        try {
          const repoHandle = await this.port.resolveRepo(dirName);
          registryName = repoHandle.name;
        } catch {
          try {
            const repoHandle = await this.port.resolveRepo(resolvedPath);
            registryName = repoHandle.name;
          } catch {
            registryName = dirName;
          }
        }

        repos[dirName] = registryName;

        const manifest = readNpmManifest(resolvedPath);
        discoveredRepos.push({
          name: registryName,
          path: resolvedPath,
          packageName: manifest?.packageName ?? null,
        });
      }
    } else {
      // Directory scan mode
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fsp.readdir(directory, { withFileTypes: true });
      } catch {
        return { error: `Cannot read directory: ${directory}` };
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const repoPath = path.join(directory, entry.name);
        const metaPath = path.join(repoPath, '.gitnexus', 'meta.json');

        let metaExists = false;
        try {
          await fsp.access(metaPath);
          metaExists = true;
        } catch {
          // Not indexed
        }
        if (!metaExists) continue;

        // Find the registry name for this repo
        let registryName: string | null = null;
        try {
          const repoHandle = await this.port.resolveRepo(entry.name);
          registryName = repoHandle.name;
        } catch {
          // Try resolving by path
          try {
            const repoHandle = await this.port.resolveRepo(repoPath);
            registryName = repoHandle.name;
          } catch {
            // Use directory name as fallback
            registryName = entry.name;
          }
        }

        const groupPath = entry.name;
        repos[groupPath] = registryName;

        // Read package manifest for auto-discovery
        const manifest = readNpmManifest(repoPath);
        discoveredRepos.push({
          name: registryName,
          path: repoPath,
          packageName: manifest?.packageName ?? null,
        });
      }
    } // end else (directory scan mode)

    if (Object.keys(repos).length === 0) {
      return { error: `No indexed repos found. Run 'gitnexus analyze' in each repo first.` };
    }

    // Build packages mapping from discovered manifests
    const pkgToGroupPath = new Map<string, string>();
    for (const repo of discoveredRepos) {
      if (repo.packageName) {
        const groupPath = Object.entries(repos).find(([, name]) => name === repo.name)?.[0];
        if (groupPath) pkgToGroupPath.set(repo.packageName, groupPath);
      }
    }

    // Create the group
    const gitnexusDir = getDefaultGitnexusDir();
    const groupDir = await createGroupDir(gitnexusDir, groupName, force);

    // Write a populated group.yaml
    const { createRequire } = await import('node:module');
    const _require = createRequire(import.meta.url);
    const yaml = _require('js-yaml') as typeof import('js-yaml');

    const config = {
      version: 1,
      name: groupName,
      description: `Auto-discovered from ${directory}`,
      repos,
      links: [],
      packages,
      detect: {
        http: true,
        grpc: true,
        topics: true,
        shared_libs: true,
        embedding_fallback: false,
      },
      matching: {
        bm25_threshold: 0.7,
        embedding_threshold: 0.65,
        max_candidates_per_step: 3,
      },
    };

    await fsp.writeFile(path.join(groupDir, 'group.yaml'), yaml.dump(config), 'utf-8');

    // Optionally run sync
    let syncResult = null;
    if (!skipSync) {
      syncResult = await syncGroup(config, {
        groupDir,
        exactOnly: true,
      });
    }

    return {
      group: groupName,
      groupDir,
      repos: discoveredRepos.map((r) => ({
        name: r.name,
        packageName: r.packageName,
      })),
      repoCount: Object.keys(repos).length,
      packageMappings: Object.fromEntries(pkgToGroupPath),
      synced: !skipSync,
      ...(syncResult
        ? {
            contracts: syncResult.contracts.length,
            crossLinks: syncResult.crossLinks.length,
          }
        : {}),
    };
  }
}
