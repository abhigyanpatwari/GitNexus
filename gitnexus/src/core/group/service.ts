/**
 * Cross-repo group orchestration shared by MCP (LocalBackend) and CLI.
 * DB access is injected via GroupToolPort so this module stays free of LocalBackend private API.
 */

import { checkStaleness } from '../git-staleness.js';
import { queryBridge, closeBridgeDb } from './bridge-db.js';
import { loadGroupConfig } from './config-parser.js';
import { runGroupImpact, runGroupImpactLegacy } from './cross-impact.js';
import { getDefaultGitnexusDir, getGroupDir, listGroups, openBridgeOrFallback } from './storage.js';
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

    const fallback = await openBridgeOrFallback(groupDir);
    if (fallback.type === 'none') {
      return { error: `No contract data for group "${name}". Run group_sync first.` };
    }

    if (fallback.type === 'json') {
      const registry = fallback.registry;
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

    // Bridge path — query Contract nodes with flat field projection
    const handle = fallback.handle;
    try {
      let cypher = 'MATCH (c:Contract)';
      const queryParams: Record<string, unknown> = {};
      const whereClauses: string[] = [];
      if (params.type) {
        whereClauses.push('c.type = $type');
        queryParams.type = params.type;
      }
      if (params.repo) {
        whereClauses.push('c.repo = $repo');
        queryParams.repo = params.repo;
      }
      if (whereClauses.length > 0) {
        cypher += ` WHERE ${whereClauses.join(' AND ')}`;
      }
      cypher +=
        ' RETURN c.contractId AS contractId, c.type AS type, c.role AS role, c.repo AS repo,' +
        ' c.service AS service, c.symbolUid AS symbolUid, c.filePath AS filePath,' +
        ' c.symbolName AS symbolName, c.confidence AS confidence, c.meta AS meta';

      const rawContracts = await queryBridge<{
        contractId: string;
        type: string;
        role: string;
        repo: string;
        service: string;
        symbolUid: string;
        filePath: string;
        symbolName: string;
        confidence: number;
        meta: string;
      }>(handle, cypher, queryParams as Record<string, import('@ladybugdb/core').LbugValue>);

      // Reconstruct StoredContract shape for CLI compatibility.
      // meta is stored in the bridge as a JSON-stringified blob (see
      // writeBridge()). A single corrupted or non-JSON meta row must not
      // take down the whole groupContracts() call — degrade to an empty
      // object for that row and keep going. The error is swallowed
      // intentionally here because there is no per-row logger yet; the
      // metaParseFailures counter is returned so callers can surface it.
      let metaParseFailures = 0;
      const safeParseMeta = (raw: unknown): Record<string, unknown> => {
        if (raw == null) return {};
        if (typeof raw !== 'string') return raw as Record<string, unknown>;
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          metaParseFailures++;
          return {};
        }
      };
      let contracts = rawContracts.map((r) => ({
        contractId: r.contractId,
        type: r.type,
        role: r.role,
        repo: r.repo,
        service: r.service,
        symbolUid: r.symbolUid,
        symbolRef: { filePath: r.filePath, name: r.symbolName },
        symbolName: r.symbolName,
        confidence: r.confidence,
        meta: safeParseMeta(r.meta),
      }));

      // Query cross-links
      const rawLinks = await queryBridge<{
        fromRepo: string;
        toRepo: string;
        matchType: string;
        confidence: number;
        linkContractId: string;
      }>(
        handle,
        `MATCH (a:Contract)-[l:ContractLink]->(b:Contract)
         RETURN l.fromRepo AS fromRepo, l.toRepo AS toRepo,
                l.matchType AS matchType, l.confidence AS confidence,
                l.contractId AS linkContractId`,
      );
      const crossLinks = rawLinks.map((l) => ({
        from: { repo: l.fromRepo },
        to: { repo: l.toRepo },
        matchType: l.matchType,
        confidence: l.confidence,
        contractId: l.linkContractId,
      }));

      // Apply unmatchedOnly filter
      if (params.unmatchedOnly) {
        const matchedIds = new Set(
          crossLinks.flatMap((l) => [
            `${l.from.repo}::${l.contractId}`,
            `${l.to.repo}::${l.contractId}`,
          ]),
        );
        contracts = contracts.filter((c) => !matchedIds.has(`${c.repo}::${c.contractId}`));
      }

      return {
        contracts,
        crossLinks,
        ...(metaParseFailures > 0 ? { metaParseFailures } : {}),
      };
    } finally {
      await closeBridgeDb(handle);
    }
  }

  async groupImpact(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    const targetSymbol = String(params.target ?? '').trim();
    const repoGroupPath = String(params.repo ?? '').trim();
    if (!name || !targetSymbol || !repoGroupPath) {
      return { error: 'name, target, and repo are required' };
    }

    // Strict validation for numeric/enum params — MCP is a public interface
    // and the worker may be invoked by untrusted LLMs. Bounds are chosen
    // conservatively to prevent DoS (unbounded impact walks, long timeouts)
    // while still allowing reasonable traversal.
    if (
      params.direction !== undefined &&
      params.direction !== 'upstream' &&
      params.direction !== 'downstream'
    ) {
      return {
        error: `direction must be 'upstream' or 'downstream', got ${JSON.stringify(params.direction)}`,
      };
    }
    const direction: 'upstream' | 'downstream' =
      params.direction === 'downstream' ? 'downstream' : 'upstream';

    const maxDepthRaw = params.maxDepth;
    if (maxDepthRaw !== undefined) {
      if (
        typeof maxDepthRaw !== 'number' ||
        !Number.isFinite(maxDepthRaw) ||
        !Number.isInteger(maxDepthRaw) ||
        maxDepthRaw < 1 ||
        maxDepthRaw > 10
      ) {
        return {
          error: `maxDepth must be an integer in [1, 10], got ${JSON.stringify(maxDepthRaw)}`,
        };
      }
    }
    const maxDepth = typeof maxDepthRaw === 'number' ? maxDepthRaw : 3;

    const minConfidenceRaw = params.minConfidence;
    if (minConfidenceRaw !== undefined) {
      if (
        typeof minConfidenceRaw !== 'number' ||
        !Number.isFinite(minConfidenceRaw) ||
        minConfidenceRaw < 0 ||
        minConfidenceRaw > 1
      ) {
        return {
          error: `minConfidence must be a number in [0, 1], got ${JSON.stringify(minConfidenceRaw)}`,
        };
      }
    }
    const minConfidence = typeof minConfidenceRaw === 'number' ? minConfidenceRaw : 0.5;

    const timeoutRaw = params.timeout;
    if (timeoutRaw !== undefined) {
      if (
        typeof timeoutRaw !== 'number' ||
        !Number.isFinite(timeoutRaw) ||
        timeoutRaw < 100 ||
        timeoutRaw > 300000
      ) {
        return {
          error: `timeout must be a number in [100, 300000] ms, got ${JSON.stringify(timeoutRaw)}`,
        };
      }
    }
    const timeout = typeof timeoutRaw === 'number' ? timeoutRaw : 30000;

    const crossDepthRaw = params.crossDepth;
    if (crossDepthRaw !== undefined) {
      if (
        typeof crossDepthRaw !== 'number' ||
        !Number.isFinite(crossDepthRaw) ||
        !Number.isInteger(crossDepthRaw) ||
        crossDepthRaw < 0 ||
        crossDepthRaw > 10
      ) {
        return {
          error: `crossDepth must be an integer in [0, 10], got ${JSON.stringify(crossDepthRaw)}`,
        };
      }
    }
    const requestedCrossDepth = typeof crossDepthRaw === 'number' ? crossDepthRaw : 1;

    const subgroup = typeof params.subgroup === 'string' ? params.subgroup : undefined;
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);

    const config = await loadGroupConfig(groupDir);

    const fallback = await openBridgeOrFallback(groupDir);
    if (fallback.type === 'none') {
      return { error: `No contract data for group "${name}". Run group_sync first.` };
    }
    // NOTE: crossDepth is clamped to 1 by runGroupImpact itself
    // (MAX_SUPPORTED_CROSS_DEPTH); we only surface a warning here.
    const crossDepth = Math.max(0, Math.min(requestedCrossDepth, 1));
    const crossDepthWarning =
      requestedCrossDepth > 1
        ? `Multi-hop cross-boundary traversal is not yet implemented. Using --cross-depth 1 (requested: ${requestedCrossDepth}).`
        : undefined;

    const defaultRelTypes = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];

    // impactOpts.minConfidence is intentionally 0: it's applied to the
    // intra-repo impact walk where edges (CALLS/IMPORTS/EXTENDS/IMPLEMENTS)
    // don't carry a meaningful confidence score. The user-facing
    // `minConfidence` param filters CROSS-REPO contract links in
    // runGroupImpact/runGroupImpactLegacy (see minConfidence passed below).
    const impactOpts = {
      maxDepth,
      relationTypes: defaultRelTypes,
      minConfidence: 0,
      includeTests: false,
    };

    const resolveGroupRepo = async (groupPath: string): Promise<GroupRepoHandle> => {
      const registryName = config.repos[groupPath];
      if (!registryName) throw new Error(`Repo "${groupPath}" not found in group "${name}"`);
      return this.port.resolveRepo(registryName);
    };

    // Wrap localImpactFn callbacks so any exception (e.g. resolveGroupRepo
    // throwing on a missing repo) becomes a null/error result instead of
    // bubbling past runPhase1WithTimeout (which only catches timeouts, not
    // rejections). Without this wrap, an unhandled rejection from the
    // callback would crash the MCP tool handler.
    const safeLocalImpact = async (t: string, d: string): Promise<unknown> => {
      try {
        const repoObj = await resolveGroupRepo(repoGroupPath);
        return await this.port.impact(repoObj, {
          target: t,
          direction: d as 'upstream' | 'downstream',
          ...impactOpts,
        });
      } catch (err) {
        return {
          error: `local impact failed: ${err instanceof Error ? err.message : String(err)}`,
          target: { id: '', name: t, filePath: '' },
          direction: d,
          impactedCount: 0,
          risk: 'LOW',
          summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
          affected_processes: [],
          affected_modules: [],
          byDepth: {},
        };
      }
    };

    if (fallback.type === 'json') {
      // Legacy JSON path
      const result = await runGroupImpactLegacy({
        groupName: name,
        target: targetSymbol,
        repoPath: repoGroupPath,
        direction,
        registry: fallback.registry,
        localImpactFn: safeLocalImpact,
        crossImpactFn: async (targetGroupPath: string, uid: string, d: string) => {
          const registryName = config.repos[targetGroupPath];
          if (!registryName) return null;
          try {
            const repoObj = await this.port.resolveRepo(registryName);
            return this.port.impactByUid(repoObj.id, uid, d, impactOpts);
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
        result.crossDepthWarning = crossDepthWarning;
      }
      return result;
    }

    // Bridge path
    const handle = fallback.handle;
    try {
      const result = await runGroupImpact({
        groupName: name,
        target: targetSymbol,
        repoPath: repoGroupPath,
        direction,
        bridgeQuery: (cypher, p) =>
          queryBridge(handle, cypher, p as Record<string, import('@ladybugdb/core').LbugValue>),
        localImpactFn: safeLocalImpact,
        crossImpactFn: async (
          targetGroupPath: string,
          uid: string,
          d: string,
          hint?: { filePath: string; symbolName: string },
        ) => {
          const registryName = config.repos[targetGroupPath];
          if (!registryName) return null;
          try {
            const repoObj = await this.port.resolveRepo(registryName);
            if (uid) {
              return this.port.impactByUid(repoObj.id, uid, d, impactOpts);
            }
            // Name-based fallback for empty UID (gRPC contracts)
            if (hint?.symbolName) {
              const hintResult = await this.port.impact(repoObj, {
                target: hint.symbolName,
                direction: d as 'upstream' | 'downstream',
                ...impactOpts,
              });
              if (
                hintResult &&
                typeof hintResult === 'object' &&
                'error' in (hintResult as Record<string, unknown>)
              )
                return null;
              return hintResult;
            }
            return null;
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
        result.crossDepthWarning = crossDepthWarning;
      }
      return result;
    } finally {
      await closeBridgeDb(handle);
    }
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

    const fallback = await openBridgeOrFallback(groupDir);
    if (fallback.type === 'none') {
      return { group: name, lastSync: null, missingRepos: [], repos: {} };
    }

    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');

    if (fallback.type === 'json') {
      const registry = fallback.registry;
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
          const metaPath = pathMod.join(repoObj.storagePath, 'meta.json');
          const metaRaw = await fsp.readFile(metaPath, 'utf-8').catch(() => '{}');
          const meta = JSON.parse(metaRaw) as { lastCommit?: string; indexedAt?: string };

          const staleness = meta.lastCommit
            ? checkStaleness(repoObj.repoPath, meta.lastCommit)
            : { isStale: true, commitsBehind: -1 };

          const snapshot = registry.repoSnapshots[repoPath];
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
        lastSync: registry.generatedAt || null,
        missingRepos: registry.missingRepos || [],
        repos: repoStatuses,
      };
    }

    // Bridge path
    const handle = fallback.handle;
    const meta = fallback.meta;
    try {
      const snapshots = await queryBridge<{ id: string; indexedAt: string; lastCommit: string }>(
        handle,
        'MATCH (s:RepoSnapshot) RETURN s.id AS id, s.indexedAt AS indexedAt, s.lastCommit AS lastCommit',
      );
      const bridgeSnapshots: Record<string, { indexedAt: string; lastCommit: string }> = {};
      for (const s of snapshots) {
        bridgeSnapshots[s.id] = { indexedAt: s.indexedAt, lastCommit: s.lastCommit };
      }

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
          const metaPath = pathMod.join(repoObj.storagePath, 'meta.json');
          const metaRaw = await fsp.readFile(metaPath, 'utf-8').catch(() => '{}');
          const repoMeta = JSON.parse(metaRaw) as { lastCommit?: string; indexedAt?: string };

          const staleness = repoMeta.lastCommit
            ? checkStaleness(repoObj.repoPath, repoMeta.lastCommit)
            : { isStale: true, commitsBehind: -1 };

          const snapshot = bridgeSnapshots[repoPath];
          const contractsStale =
            snapshot && repoMeta.indexedAt ? snapshot.indexedAt !== repoMeta.indexedAt : !snapshot;

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
        lastSync: meta.generatedAt || null,
        missingRepos: meta.missingRepos || [],
        repos: repoStatuses,
      };
    } finally {
      await closeBridgeDb(handle);
    }
  }
}
