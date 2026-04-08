import type {
  ContractRegistry,
  CrossLink,
  GroupImpactResult,
  CrossRepoImpact,
  OutOfScopeLink,
} from './types.js';

export interface LegacyGroupImpactOptions {
  groupName: string;
  target: string;
  repoPath: string;
  direction: 'upstream' | 'downstream';
  registry: ContractRegistry;
  localImpactFn: (target: string, direction: string) => Promise<unknown>;
  crossImpactFn: (
    targetGroupPath: string,
    symbolUid: string,
    direction: string,
  ) => Promise<unknown | null>;
  maxDepth?: number;
  minConfidence?: number;
  subgroup?: string;
  timeout?: number;
  crossDepth?: number;
}

export interface GroupImpactOptions {
  groupName: string;
  target: string;
  repoPath: string;
  direction: 'upstream' | 'downstream';
  bridgeQuery: <T>(cypher: string, params: Record<string, unknown>) => Promise<T[]>;
  localImpactFn: (target: string, direction: string) => Promise<unknown>;
  crossImpactFn: (
    targetGroupPath: string,
    symbolUid: string,
    direction: string,
    hint?: { filePath: string; symbolName: string },
  ) => Promise<unknown | null>;
  maxDepth?: number;
  minConfidence?: number;
  subgroup?: string;
  timeout?: number;
  crossDepth?: number;
}

function collectPhase1Uids(local: Record<string, unknown>): Set<string> {
  const uids = new Set<string>();
  const target = local.target as { id?: string } | undefined;
  if (target?.id) uids.add(String(target.id));
  const byDepth = (local.byDepth || {}) as Record<string, { id?: string }[]>;
  for (const arr of Object.values(byDepth)) {
    for (const item of arr || []) {
      if (item?.id) uids.add(String(item.id));
    }
  }
  return uids;
}

function refKey(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

function collectPhase1Refs(local: Record<string, unknown>): Set<string> {
  const refs = new Set<string>();
  const t = local.target as { filePath?: string; name?: string } | undefined;
  if (t?.filePath?.length && t?.name?.length) refs.add(refKey(t.filePath, t.name));
  const byDepth = (local.byDepth || {}) as Record<string, { filePath?: string; name?: string }[]>;
  for (const arr of Object.values(byDepth)) {
    for (const item of arr || []) {
      if (item.filePath?.length && item.name?.length) refs.add(refKey(item.filePath, item.name));
    }
  }
  return refs;
}

function linkMatchesRefs(
  link: CrossLink,
  refs: Set<string>,
  direction: 'upstream' | 'downstream',
): boolean {
  if (direction === 'upstream') {
    const r = link.to.symbolRef;
    if (!r.filePath?.length || !r.name?.length) return false;
    return refs.has(refKey(r.filePath, r.name));
  }
  const r = link.from.symbolRef;
  if (!r.filePath?.length || !r.name?.length) return false;
  return refs.has(refKey(r.filePath, r.name));
}

function inSubgroup(repoPath: string, subgroup?: string): boolean {
  if (!subgroup?.trim()) return true;
  const s = subgroup.replace(/\/+$/, '');
  return repoPath === s || repoPath.startsWith(`${s}/`);
}

function mergeRisk(
  base: string,
  crossHits: number,
  maxCrossConf: number,
  distinctCrossRepos: number,
): string {
  const order = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  let idx = Math.max(0, order.indexOf(base));

  if (crossHits > 0 && maxCrossConf >= 0.85) {
    idx = Math.max(idx, order.indexOf('HIGH'));
  } else if (crossHits > 0 && maxCrossConf > 0) {
    idx = Math.max(idx, order.indexOf('MEDIUM'));
  }
  if (distinctCrossRepos >= 3) {
    idx = Math.max(idx, order.indexOf('CRITICAL'));
  }

  return order[idx] ?? base;
}

function computePhase1Timeout(timeout: number): number {
  if (timeout <= 1000) return timeout;
  return Math.min(Math.ceil(timeout * 0.3), 10000);
}

export async function runGroupImpactLegacy(
  opts: LegacyGroupImpactOptions,
): Promise<GroupImpactResult> {
  const timeout = opts.timeout ?? 30000;
  const minConfidence = opts.minConfidence ?? 0.5;
  const crossDepth = Math.min(1, opts.crossDepth ?? 1);

  const tStart = Date.now();
  const wallDeadline = tStart + timeout;
  const phase1Timeout = computePhase1Timeout(timeout);

  const localResult = await Promise.race([
    opts.localImpactFn(opts.target, opts.direction).then((v) => ({ ok: true as const, v })),
    new Promise<{ ok: false }>((resolve) =>
      setTimeout(() => resolve({ ok: false }), phase1Timeout),
    ),
  ]);

  let truncated = !localResult.ok;
  const local = localResult.ok
    ? (localResult.v as Record<string, unknown>)
    : ({
        target: { id: '', name: opts.target, filePath: '' },
        direction: opts.direction,
        impactedCount: 0,
        risk: 'LOW',
        summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
        affected_processes: [],
        affected_modules: [],
        byDepth: {},
      } as Record<string, unknown>);

  const uids = collectPhase1Uids(local);
  const phase1Refs = collectPhase1Refs(local);
  const cross: CrossRepoImpact[] = [];
  const outOfScope: OutOfScopeLink[] = [];
  const truncatedRepos: string[] = [];

  const links = [...opts.registry.crossLinks]
    .filter((l) => l.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence);

  const applicable: CrossLink[] = [];
  for (const link of links) {
    const uidMatch =
      opts.direction === 'upstream'
        ? Boolean(link.to.symbolUid && uids.has(link.to.symbolUid))
        : Boolean(link.from.symbolUid && uids.has(link.from.symbolUid));
    const refMatch = !uidMatch && linkMatchesRefs(link, phase1Refs, opts.direction);
    if (!uidMatch && !refMatch) continue;
    applicable.push(link);
  }

  let maxCrossConf = 0;
  const distinctRepos = new Set<string>();

  for (const link of applicable) {
    if (Date.now() > wallDeadline) {
      truncated = true;
      break;
    }

    const fanOutRepo = opts.direction === 'upstream' ? link.from.repo : link.to.repo;
    const symbolUid = opts.direction === 'upstream' ? link.from.symbolUid : link.to.symbolUid;

    if (!inSubgroup(fanOutRepo, opts.subgroup)) {
      outOfScope.push({
        from: link.from.repo,
        to: link.to.repo,
        contractId: link.contractId,
        confidence: link.confidence,
      });
      continue;
    }

    if (crossDepth < 1) break;

    const remote = await opts.crossImpactFn(fanOutRepo, symbolUid, opts.direction);
    if (remote) {
      maxCrossConf = Math.max(maxCrossConf, link.confidence);
      distinctRepos.add(fanOutRepo);
      const r = remote as Record<string, unknown>;
      cross.push({
        repo: fanOutRepo,
        repo_path: fanOutRepo,
        contract: {
          id: link.contractId,
          type: link.type,
          match_type: link.matchType,
          confidence: link.confidence,
        },
        by_depth: (r.byDepth || {}) as Record<string, unknown[]>,
        affected_processes: (r.affected_processes || []) as string[],
      });
    }

    if (Date.now() > wallDeadline) {
      truncated = true;
      truncatedRepos.push(fanOutRepo);
      break;
    }
  }

  const summaryLocal = (local.summary || {}) as {
    direct?: number;
    processes_affected?: number;
    modules_affected?: number;
  };

  const baseRisk = String(local.risk || 'LOW');
  const risk = mergeRisk(baseRisk, cross.length, maxCrossConf, distinctRepos.size);

  return {
    local,
    group: opts.groupName,
    cross,
    outOfScope,
    truncated,
    truncatedRepos,
    summary: {
      direct: summaryLocal.direct ?? 0,
      processes_affected: summaryLocal.processes_affected ?? 0,
      modules_affected: summaryLocal.modules_affected ?? 0,
      cross_repo_hits: cross.length,
    },
    risk,
  };
}

/* ------------------------------------------------------------------ */
/*  Cypher-based Phase 2                                               */
/* ------------------------------------------------------------------ */

const UPSTREAM_QUERY_BASE = `
MATCH (consumer:Contract)-[l:ContractLink]->(provider:Contract)
WHERE provider.repo = $sourceRepo
  AND (provider.symbolUid IN $localUids
       OR (NOT provider.symbolUid IN $localUids AND (provider.filePath + '::' + provider.symbolName) IN $localRefs))
  AND l.confidence >= $minConfidence`;

const UPSTREAM_QUERY_SUBGROUP = ` AND (consumer.repo = $subgroup OR consumer.repo STARTS WITH $subgroup + '/')`;

const UPSTREAM_QUERY_RETURN = `
RETURN consumer.repo AS fanOutRepo, consumer.symbolUid AS fanOutUid,
       consumer.filePath AS fanOutFilePath, consumer.symbolName AS fanOutSymbolName,
       provider.symbolUid AS matchedLocalUid,
       provider.filePath AS matchedLocalFilePath,
       provider.symbolName AS matchedLocalSymbolName,
       l.matchType AS matchType, l.confidence AS confidence, l.contractId AS contractId,
       consumer.type AS contractType
ORDER BY l.confidence DESC`;

const DOWNSTREAM_QUERY_BASE = `
MATCH (consumer:Contract)-[l:ContractLink]->(provider:Contract)
WHERE consumer.repo = $sourceRepo
  AND (consumer.symbolUid IN $localUids
       OR (NOT consumer.symbolUid IN $localUids AND (consumer.filePath + '::' + consumer.symbolName) IN $localRefs))
  AND l.confidence >= $minConfidence`;

const DOWNSTREAM_QUERY_SUBGROUP = ` AND (provider.repo = $subgroup OR provider.repo STARTS WITH $subgroup + '/')`;

const DOWNSTREAM_QUERY_RETURN = `
RETURN provider.repo AS fanOutRepo, provider.symbolUid AS fanOutUid,
       provider.filePath AS fanOutFilePath, provider.symbolName AS fanOutSymbolName,
       consumer.symbolUid AS matchedLocalUid,
       consumer.filePath AS matchedLocalFilePath,
       consumer.symbolName AS matchedLocalSymbolName,
       l.matchType AS matchType, l.confidence AS confidence, l.contractId AS contractId,
       consumer.type AS contractType
ORDER BY l.confidence DESC`;

interface CrossImpactRow {
  fanOutRepo: string;
  fanOutUid: string;
  fanOutFilePath: string;
  fanOutSymbolName: string;
  matchedLocalUid: string;
  matchedLocalFilePath: string;
  matchedLocalSymbolName: string;
  matchType: string;
  confidence: number;
  contractId: string;
  contractType: string;
}

export async function runGroupImpact(opts: GroupImpactOptions): Promise<GroupImpactResult> {
  const timeout = opts.timeout ?? 30000;
  const minConfidence = opts.minConfidence ?? 0.5;
  const crossDepth = Math.min(1, opts.crossDepth ?? 1);

  const tStart = Date.now();
  const wallDeadline = tStart + timeout;
  const phase1Timeout = computePhase1Timeout(timeout);

  const localResult = await Promise.race([
    opts.localImpactFn(opts.target, opts.direction).then((v) => ({ ok: true as const, v })),
    new Promise<{ ok: false }>((resolve) =>
      setTimeout(() => resolve({ ok: false }), phase1Timeout),
    ),
  ]);

  let truncated = !localResult.ok;
  const local = localResult.ok
    ? (localResult.v as Record<string, unknown>)
    : ({
        target: { id: '', name: opts.target, filePath: '' },
        direction: opts.direction,
        impactedCount: 0,
        risk: 'LOW',
        summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
        affected_processes: [],
        affected_modules: [],
        byDepth: {},
      } as Record<string, unknown>);

  const uids = collectPhase1Uids(local);
  const phase1Refs = collectPhase1Refs(local);
  const cross: CrossRepoImpact[] = [];
  const outOfScope: OutOfScopeLink[] = [];
  const truncatedRepos: string[] = [];

  /* Phase 2 — Cypher bridge query */
  const normalizedSubgroup = opts.subgroup?.trim().replace(/\/+$/, '') || null;

  const isUpstream = opts.direction === 'upstream';
  const queryBase = isUpstream ? UPSTREAM_QUERY_BASE : DOWNSTREAM_QUERY_BASE;
  const querySubgroup = isUpstream ? UPSTREAM_QUERY_SUBGROUP : DOWNSTREAM_QUERY_SUBGROUP;
  const queryReturn = isUpstream ? UPSTREAM_QUERY_RETURN : DOWNSTREAM_QUERY_RETURN;

  const cypher = normalizedSubgroup
    ? queryBase + querySubgroup + queryReturn
    : queryBase + queryReturn;

  const queryParams: Record<string, unknown> = {
    sourceRepo: opts.repoPath,
    localUids: [...uids],
    localRefs: [...phase1Refs],
    minConfidence,
  };
  if (normalizedSubgroup) {
    queryParams.subgroup = normalizedSubgroup;
  }

  const rows = await opts.bridgeQuery<CrossImpactRow>(cypher, queryParams);

  let maxCrossConf = 0;
  const distinctRepos = new Set<string>();

  for (const row of rows) {
    if (!inSubgroup(row.fanOutRepo, opts.subgroup)) {
      outOfScope.push({
        from: row.fanOutRepo,
        to: opts.repoPath,
        contractId: row.contractId,
        matchType: row.matchType as OutOfScopeLink['matchType'],
        confidence: row.confidence,
      });
      continue;
    }

    if (Date.now() > wallDeadline) {
      truncated = true;
      break;
    }
    if (crossDepth < 1) break;

    const hint = row.fanOutUid
      ? undefined
      : { filePath: row.fanOutFilePath, symbolName: row.fanOutSymbolName };
    const remote = await opts.crossImpactFn(row.fanOutRepo, row.fanOutUid, opts.direction, hint);

    if (remote && typeof remote === 'object' && !('error' in (remote as Record<string, unknown>))) {
      maxCrossConf = Math.max(maxCrossConf, row.confidence);
      distinctRepos.add(row.fanOutRepo);
      const r = remote as Record<string, unknown>;
      cross.push({
        repo: row.fanOutRepo,
        repo_path: row.fanOutRepo,
        contract: {
          id: row.contractId,
          type: row.contractType as CrossRepoImpact['contract']['type'],
          match_type: row.matchType as CrossRepoImpact['contract']['match_type'],
          confidence: row.confidence,
        },
        by_depth: (r.byDepth || {}) as Record<string, unknown[]>,
        affected_processes: (r.affected_processes || []) as string[],
      });
    }

    if (Date.now() > wallDeadline) {
      truncated = true;
      truncatedRepos.push(row.fanOutRepo);
      break;
    }
  }

  const summaryLocal = (local.summary || {}) as {
    direct?: number;
    processes_affected?: number;
    modules_affected?: number;
  };

  const baseRisk = String(local.risk || 'LOW');
  const risk = mergeRisk(baseRisk, cross.length, maxCrossConf, distinctRepos.size);

  return {
    local,
    group: opts.groupName,
    cross,
    outOfScope,
    truncated,
    truncatedRepos,
    summary: {
      direct: summaryLocal.direct ?? 0,
      processes_affected: summaryLocal.processes_affected ?? 0,
      modules_affected: summaryLocal.modules_affected ?? 0,
      cross_repo_hits: cross.length,
    },
    risk,
  };
}
