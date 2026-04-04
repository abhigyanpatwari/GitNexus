import type {
  ContractRegistry,
  CrossLink,
  GroupImpactResult,
  CrossRepoImpact,
  OutOfScopeLink,
} from './types.js';

export interface GroupImpactOptions {
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

export async function runGroupImpact(opts: GroupImpactOptions): Promise<GroupImpactResult> {
  const timeout = opts.timeout ?? 30000;
  const minConfidence = opts.minConfidence ?? 0.5;
  const crossDepth = Math.min(1, opts.crossDepth ?? 1);

  const tStart = Date.now();
  const wallDeadline = tStart + timeout;
  const phase1Timeout = Math.min(5000, timeout);

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
