/**
 * Cross-repo impact (Phase 1 local walk + Phase 2 bridge fan-out).
 * All bridge Cypher for this feature lives in this module.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  BridgeHandle,
  ContractType,
  CrossRepoImpact,
  GroupConfig,
  GroupImpactResult,
  MatchType,
  OutOfScopeLink,
} from './types.js';
import type { GroupRepoHandle, GroupToolPort } from './service.js';
import { GroupNotFoundError, loadGroupConfig } from './config-parser.js';
import {
  fileMatchesServicePrefix,
  normalizeServicePrefix,
  repoInSubgroup,
} from './group-path-utils.js';
import { getGroupDir } from './storage.js';
import { closeBridgeDb, openBridgeDbReadOnly, queryBridge, readBridgeMeta } from './bridge-db.js';
import { BRIDGE_SCHEMA_VERSION } from './bridge-schema.js';

/** Cross-boundary hops beyond this value are clamped (multi-hop reserved for future work). */
export const MAX_SUPPORTED_CROSS_DEPTH = 1;

/** Default wall-clock budget for the Phase 1 `impact` leg when callers omit `timeoutMs`. */
export const DEFAULT_LOCAL_IMPACT_TIMEOUT_MS = 30_000;

const CY_NEIGHBORS_UPSTREAM = `
MATCH (consumer:Contract)-[l:ContractLink]->(provider:Contract)
WHERE provider.repo = $localRepo
  AND provider.symbolUid IN $uids
  AND provider.role = 'provider'
RETURN consumer.repo AS neighborRepo,
       consumer.symbolUid AS neighborUid,
       consumer.filePath AS neighborFilePath,
       l.matchType AS matchType,
       l.confidence AS confidence,
       l.contractId AS contractId,
       consumer.type AS contractType
`;

const CY_NEIGHBORS_DOWNSTREAM = `
MATCH (consumer:Contract)-[l:ContractLink]->(provider:Contract)
WHERE consumer.repo = $localRepo
  AND consumer.symbolUid IN $uids
  AND consumer.role = 'consumer'
RETURN provider.repo AS neighborRepo,
       provider.symbolUid AS neighborUid,
       provider.filePath AS neighborFilePath,
       l.matchType AS matchType,
       l.confidence AS confidence,
       l.contractId AS contractId,
       provider.type AS contractType
`;

type BridgeNeighborRow = {
  neighborRepo: string;
  neighborUid: string;
  neighborFilePath?: string;
  matchType: string;
  confidence: number;
  contractId: string;
  contractType: string;
};

export interface RunGroupImpactDeps {
  port: GroupToolPort;
  gitnexusDir: string;
}

function parseDirection(raw: unknown): 'upstream' | 'downstream' | null {
  if (raw === 'upstream' || raw === 'downstream') return raw;
  return null;
}

function clampCrossDepth(raw: unknown): { depth: number; warning?: string } {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 1;
  const d = n < 1 ? 1 : n;
  if (d > MAX_SUPPORTED_CROSS_DEPTH) {
    return {
      depth: MAX_SUPPORTED_CROSS_DEPTH,
      warning: `crossDepth was ${d}; multi-hop cross-boundary traversal beyond ${MAX_SUPPORTED_CROSS_DEPTH} is not implemented yet. Using crossDepth ${MAX_SUPPORTED_CROSS_DEPTH}.`,
    };
  }
  return { depth: d };
}

/**
 * Clamp the impact timeout to a sane bounded range. Callers can feed this
 * via tool params, so an unclamped value lets a single request hold a
 * timer slot for an arbitrarily long duration (CodeQL js/resource-
 * exhaustion). 100ms lower bound preserves test-suite scenarios that
 * exercise tight timeouts; 5min upper bound is well above any legitimate
 * single-impact compute. Applied at the validate boundary so the
 * downstream `deadline` (Date.now() + timeoutMs) and the local-leg
 * `setTimeout` see the same clamped value — earlier shapes had a 1hr
 * outer cap and a 5min inner clamp that disagreed.
 */
export const IMPACT_TIMEOUT_MIN_MS = 100;
export const IMPACT_TIMEOUT_MAX_MS = 5 * 60 * 1_000;

export function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return IMPACT_TIMEOUT_MIN_MS;
  return Math.min(IMPACT_TIMEOUT_MAX_MS, Math.max(IMPACT_TIMEOUT_MIN_MS, Math.trunc(timeoutMs)));
}

export function validateGroupImpactParams(params: Record<string, unknown>):
  | {
      ok: true;
      name: string;
      repoPath: string;
      target: string;
      direction: 'upstream' | 'downstream';
      maxDepth: number;
      crossDepth: number;
      crossDepthWarning?: string;
      relationTypes?: string[];
      includeTests: boolean;
      minConfidence: number;
      service?: string;
      subgroup?: string;
      timeoutMs: number;
    }
  | { ok: false; error: string } {
  const name = String(params.name ?? '').trim();
  const repoPath = String(params.repo ?? '').trim();
  const target = String(params.target ?? '').trim();
  if (!name) return { ok: false, error: 'name is required' };
  if (!repoPath)
    return { ok: false, error: 'repo is required (group repo path, e.g. app/backend)' };
  if (!target) return { ok: false, error: 'target is required' };
  if (
    params.service !== undefined &&
    params.service !== null &&
    String(params.service).trim() === ''
  ) {
    return { ok: false, error: 'service must not be an empty string' };
  }
  const direction = parseDirection(params.direction);
  if (!direction) return { ok: false, error: 'direction must be upstream or downstream' };

  let maxDepth = typeof params.maxDepth === 'number' && params.maxDepth > 0 ? params.maxDepth : 3;
  if (maxDepth > 32) maxDepth = 32;

  const { depth: crossDepth, warning: crossDepthWarning } = clampCrossDepth(params.crossDepth);

  const relationTypes = Array.isArray(params.relationTypes)
    ? params.relationTypes.filter((t): t is string => typeof t === 'string')
    : undefined;

  const includeTests = Boolean(params.includeTests);
  let minConfidence = typeof params.minConfidence === 'number' ? params.minConfidence : 0;
  if (minConfidence < 0) minConfidence = 0;
  if (minConfidence > 1) minConfidence = 1;

  const service = normalizeServicePrefix(params.service);
  const subgroup = typeof params.subgroup === 'string' ? params.subgroup : undefined;

  // Clamp at the validate boundary so the downstream `deadline` (line
  // ~366) and `safeLocalImpact`'s `setTimeout` both see a single
  // bounded value. Without this, the outer deadline budgeted Phase-2
  // cross-repo fanout up to 1hr while only the inner setTimeout was
  // capped to 5min — the two halves of CodeQL #184's mitigation
  // disagreed.
  const rawTimeoutMs =
    typeof params.timeoutMs === 'number' && params.timeoutMs > 0
      ? params.timeoutMs
      : typeof params.timeout === 'number' && params.timeout > 0
        ? params.timeout
        : DEFAULT_LOCAL_IMPACT_TIMEOUT_MS;
  const timeoutMs = clampTimeout(rawTimeoutMs);

  return {
    ok: true,
    name,
    repoPath,
    target,
    direction,
    maxDepth,
    crossDepth,
    crossDepthWarning,
    relationTypes,
    includeTests,
    minConfidence,
    service,
    subgroup,
    timeoutMs,
  };
}

async function resolveGroupRepo(
  port: GroupToolPort,
  config: GroupConfig,
  repoPath: string,
): Promise<GroupRepoHandle | { error: string }> {
  const registryName = config.repos[repoPath];
  if (!registryName) {
    return { error: `Unknown repo path "${repoPath}" in this group.` };
  }
  try {
    return await port.resolveRepo(registryName);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function safeLocalImpact(
  port: GroupToolPort,
  repo: GroupRepoHandle,
  impactParams: Parameters<GroupToolPort['impact']>[1],
  timeoutMs: number,
): Promise<{ value: unknown; timedOut: boolean }> {
  const safeTimeoutMs = clampTimeout(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const impactP = port.impact(repo, impactParams).catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
  }));
  const timeoutP = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), safeTimeoutMs);
  });
  const won = await Promise.race([
    impactP.then((v) => ({ tag: 'impact' as const, v })),
    timeoutP.then(() => ({ tag: 'timeout' as const })),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (won.tag === 'timeout') {
    return {
      value: { error: 'Local impact timed out', partial: true },
      timedOut: true,
    };
  }
  return { value: won.v, timedOut: false };
}

/**
 * Race a single Phase-2 `impactByUid` call against a remaining-budget
 * timer. The Codex adversarial review on PR #1331 surfaced that the
 * fanout loop only checked `Date.now() > deadline` *between* neighbor
 * calls — once `await port.impactByUid(...)` was reached, a hung
 * neighbor could pin the request indefinitely, and slow neighbors
 * could compound past the 5-min `IMPACT_TIMEOUT_MAX_MS` cap.
 *
 * This helper wraps each call: a `setTimeout(remainingMs)` aborts an
 * `AbortController` whose signal is forwarded to `impactByUid`, and a
 * `Promise.race` resolves to `{ timedOut: true }` when the timer
 * fires before the call completes. Implementors that ignore the
 * signal (current local backend) still see their await resolved by
 * the race; full cooperative cancellation inside the BFS is a future
 * follow-up. On rejection, the value is `null` (matching the
 * fanout's existing `if (fan == null)` truncation contract).
 *
 * Exported for direct unit testing — the helper IS the load-bearing
 * mitigation surface, so the U3 regression test pins it directly
 * rather than driving the full `runGroupImpact` path.
 */
export async function safeNeighborImpact(
  port: GroupToolPort,
  repoId: string,
  uid: string,
  direction: string,
  opts: {
    maxDepth: number;
    relationTypes: string[];
    minConfidence: number;
    includeTests: boolean;
  },
  remainingMs: number,
): Promise<{ value: unknown; timedOut: boolean }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const callP = port
    .impactByUid(repoId, uid, direction, { ...opts, signal: controller.signal })
    .catch(() => null);
  const timeoutP = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort();
        resolve('timeout');
      },
      Math.max(0, remainingMs),
    );
  });
  const won = await Promise.race([
    callP.then((v) => ({ tag: 'impact' as const, v })),
    timeoutP.then(() => ({ tag: 'timeout' as const })),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (won.tag === 'timeout') {
    return { value: null, timedOut: true };
  }
  return { value: won.v, timedOut: false };
}

export function collectImpactSymbolUids(
  local: unknown,
  servicePrefix: string | undefined,
): { uids: string[]; targetFilePath?: string } {
  const uids = new Set<string>();
  let targetFilePath: string | undefined;
  const obj = local as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return { uids: [], targetFilePath };

  const target = obj.target as { id?: string; filePath?: string } | undefined;
  if (target?.id) {
    targetFilePath = typeof target.filePath === 'string' ? target.filePath : undefined;
    if (fileMatchesServicePrefix(targetFilePath, servicePrefix)) {
      uids.add(String(target.id));
    }
  }

  const byDepth = obj.byDepth as Record<string | number, unknown> | undefined;
  if (byDepth && typeof byDepth === 'object') {
    for (const items of Object.values(byDepth)) {
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        const row = it as { id?: string; filePath?: string };
        if (row?.id && fileMatchesServicePrefix(row.filePath, servicePrefix)) {
          uids.add(String(row.id));
        }
      }
    }
  }
  return { uids: [...uids], targetFilePath };
}

function extractProcessNames(impact: unknown): string[] {
  const o = impact as { affected_processes?: Array<{ name?: string }> };
  if (!o?.affected_processes) return [];
  return o.affected_processes.map((p) => String(p.name ?? '')).filter(Boolean);
}

function mergeRisk(localRisk: string, cross: CrossRepoImpact[]): string {
  const highConf = cross.some((c) => c.contract.confidence >= 0.85);
  if (localRisk === 'CRITICAL') return 'CRITICAL';
  if (cross.length >= 3) return 'CRITICAL';
  if (highConf) return 'HIGH';
  if (cross.length > 0 && (localRisk === 'LOW' || localRisk === 'UNKNOWN')) return 'MEDIUM';
  return localRisk;
}

async function ensureBridgeReady(
  groupDir: string,
): Promise<{ handle: BridgeHandle } | { error: string }> {
  const meta = await readBridgeMeta(groupDir);
  if (meta.version > 0 && meta.version !== BRIDGE_SCHEMA_VERSION) {
    return {
      error: `Bridge schema version mismatch (meta.json has ${meta.version}, expected ${BRIDGE_SCHEMA_VERSION}). Run gitnexus group sync for this group.`,
    };
  }
  const dbPath = path.join(groupDir, 'bridge.lbug');
  try {
    await fsp.access(dbPath);
  } catch {
    return {
      error: `No bridge.lbug in this group directory. Run gitnexus group sync (schema ${BRIDGE_SCHEMA_VERSION}).`,
    };
  }
  const handle = await openBridgeDbReadOnly(groupDir);
  if (!handle) {
    return {
      error: `Could not open bridge.lbug read-only (schema ${BRIDGE_SCHEMA_VERSION}). Run gitnexus group sync.`,
    };
  }
  return { handle };
}

function rowToNeighbor(r: Record<string, unknown>): BridgeNeighborRow | null {
  const neighborRepo = String(r.neighborRepo ?? r[0] ?? '');
  const neighborUid = String(r.neighborUid ?? r[1] ?? '');
  if (!neighborRepo || !neighborUid) return null;
  return {
    neighborRepo,
    neighborUid,
    neighborFilePath:
      r.neighborFilePath !== undefined ? String(r.neighborFilePath) : String(r[2] ?? ''),
    matchType: String(r.matchType ?? r[3] ?? 'exact'),
    confidence: Number(r.confidence ?? r[4] ?? 0),
    contractId: String(r.contractId ?? r[5] ?? ''),
    contractType: String(r.contractType ?? r[6] ?? 'custom'),
  };
}

export async function runGroupImpact(
  deps: RunGroupImpactDeps,
  params: Record<string, unknown>,
): Promise<GroupImpactResult | { error: string }> {
  const parsed = validateGroupImpactParams(params);
  if (parsed.ok === false) return { error: parsed.error };

  const {
    name,
    repoPath,
    target,
    direction,
    maxDepth,
    crossDepth: _crossDepth,
    crossDepthWarning,
    relationTypes,
    includeTests,
    minConfidence,
    service: servicePrefix,
    subgroup,
    timeoutMs,
  } = parsed;

  const groupDir = getGroupDir(deps.gitnexusDir, name);
  let config: GroupConfig;
  try {
    config = await loadGroupConfig(groupDir);
  } catch (e) {
    if (e instanceof GroupNotFoundError)
      return { error: `Group "${name}" not found. Run group_list to see configured groups.` };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const resolved = await resolveGroupRepo(deps.port, config, repoPath);
  if ('error' in resolved) return { error: resolved.error };

  const impactParams: Parameters<GroupToolPort['impact']>[1] = {
    target,
    direction,
    maxDepth,
    relationTypes: relationTypes && relationTypes.length > 0 ? relationTypes : undefined,
    includeTests,
    minConfidence,
  };

  const deadline = Date.now() + Math.max(0, timeoutMs);

  const { value: local, timedOut: localTimedOut } = await safeLocalImpact(
    deps.port,
    resolved,
    impactParams,
    timeoutMs,
  );

  if (localTimedOut) {
    const _base = local as Record<string, unknown>;
    return {
      local,
      group: name,
      cross: [],
      outOfScope: [],
      truncated: true,
      truncatedRepos: [],
      summary: {
        direct: 0,
        processes_affected: 0,
        modules_affected: 0,
        cross_repo_hits: 0,
      },
      risk: 'UNKNOWN',
      timeoutMs,
      truncationReason: 'timeout',
      crossDepthWarning,
    };
  }

  const localObj = local as Record<string, unknown> | null;
  if (localObj?.error && typeof localObj.error === 'string') {
    // Fail closed: the local-impact phase errored (missing symbol, graph-load
    // failure, thrown exception wrapped by safeLocalImpact, or port-returned
    // `{ error }`). Do NOT wrap it into a zero-hit success payload — callers
    // branch on top-level `error`, and a blast-radius tool reporting "no
    // impact" on the failure path is a false negative on a safety-critical
    // signal. Bubble the error so consumers treat it as a failure.
    return { error: `Local impact failed for ${repoPath}: ${localObj.error}` };
  }

  if (servicePrefix) {
    const tf = (localObj?.target as { filePath?: string } | undefined)?.filePath;
    if (!fileMatchesServicePrefix(tf, servicePrefix)) {
      return {
        local: {},
        group: name,
        cross: [],
        outOfScope: [],
        truncated: false,
        truncatedRepos: [],
        summary: {
          direct: 0,
          processes_affected: 0,
          modules_affected: 0,
          cross_repo_hits: 0,
        },
        risk: 'LOW',
        timeoutMs,
        crossDepthWarning,
      };
    }
  }

  const { uids } = collectImpactSymbolUids(local, servicePrefix);
  if (uids.length === 0) {
    const s = (local as { summary?: Record<string, number> })?.summary || {};
    return {
      local,
      group: name,
      cross: [],
      outOfScope: [],
      truncated: Boolean((local as { partial?: boolean }).partial),
      truncatedRepos: [],
      summary: {
        direct: s.direct ?? 0,
        processes_affected: s.processes_affected ?? 0,
        modules_affected: s.modules_affected ?? 0,
        cross_repo_hits: 0,
      },
      risk: String((local as { risk?: string }).risk ?? 'LOW'),
      timeoutMs,
      truncationReason: (local as { partial?: boolean }).partial ? 'partial' : undefined,
      crossDepthWarning,
    };
  }

  const bridgePrep = await ensureBridgeReady(groupDir);
  if ('error' in bridgePrep) return { error: bridgePrep.error };

  const handle = bridgePrep.handle;
  const cross: CrossRepoImpact[] = [];
  const outOfScope: OutOfScopeLink[] = [];
  const truncatedRepos: string[] = [];

  try {
    const cypher = direction === 'upstream' ? CY_NEIGHBORS_UPSTREAM : CY_NEIGHBORS_DOWNSTREAM;
    const rows = await queryBridge<Record<string, unknown>>(handle, cypher, {
      localRepo: repoPath,
      uids,
    });

    const neighbors: BridgeNeighborRow[] = [];
    for (const raw of rows) {
      const n = rowToNeighbor(raw);
      if (n) neighbors.push(n);
    }
    neighbors.sort((a, b) => b.confidence - a.confidence);

    const seen = new Set<string>();

    for (const n of neighbors) {
      if (servicePrefix && !fileMatchesServicePrefix(n.neighborFilePath, servicePrefix)) {
        continue;
      }
      if (!repoInSubgroup(n.neighborRepo, subgroup)) {
        outOfScope.push({
          from: direction === 'upstream' ? n.neighborRepo : repoPath,
          to: direction === 'upstream' ? repoPath : n.neighborRepo,
          contractId: n.contractId,
          confidence: n.confidence,
        });
        continue;
      }

      const key = `${n.neighborRepo}\0${n.neighborUid}\0${n.contractId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        truncatedRepos.push(n.neighborRepo);
        continue;
      }

      const regName = config.repos[n.neighborRepo];
      if (!regName) continue;

      let neighborHandle: GroupRepoHandle;
      try {
        neighborHandle = await deps.port.resolveRepo(regName);
      } catch {
        truncatedRepos.push(n.neighborRepo);
        continue;
      }

      // Phase-2 hardening: race each impactByUid against a per-call
      // timeout derived from the remaining budget. Without this wrap a
      // single hung neighbor would pin the request past the clamped
      // timeout, which Codex's adversarial review on PR #1331 flagged
      // as the still-open half of CodeQL #184 / js/resource-exhaustion.
      const { value: fan, timedOut: neighborTimedOut } = await safeNeighborImpact(
        deps.port,
        neighborHandle.id,
        n.neighborUid,
        direction,
        {
          maxDepth,
          relationTypes: relationTypes ?? [],
          minConfidence,
          includeTests,
        },
        remainingMs,
      );
      if (neighborTimedOut || fan == null) {
        truncatedRepos.push(n.neighborRepo);
        continue;
      }

      cross.push({
        repo: regName,
        repo_path: n.neighborRepo,
        contract: {
          id: n.contractId,
          type: n.contractType as ContractType,
          match_type: (n.matchType as MatchType) || 'exact',
          confidence: n.confidence,
        },
        by_depth: ((fan as { byDepth?: unknown }).byDepth ?? {}) as Record<string, unknown[]>,
        affected_processes: extractProcessNames(fan),
      });
    }
  } finally {
    await closeBridgeDb(handle);
  }

  const localSum = (local as { summary?: Record<string, number> })?.summary || {};
  const localRisk = String((local as { risk?: string }).risk ?? 'LOW');
  const localPartial = Boolean((local as { partial?: boolean }).partial);
  const truncated = truncatedRepos.length > 0 || localPartial;

  const result: GroupImpactResult = {
    local,
    group: name,
    cross,
    outOfScope,
    truncated,
    truncatedRepos: [...new Set(truncatedRepos)],
    summary: {
      direct: localSum.direct ?? 0,
      processes_affected: localSum.processes_affected ?? 0,
      modules_affected: localSum.modules_affected ?? 0,
      cross_repo_hits: cross.length,
    },
    risk: mergeRisk(localRisk, cross),
    timeoutMs,
    truncationReason: truncated ? 'partial' : undefined,
    crossDepthWarning,
  };
  return result;
}

export { normalizeServicePrefix, fileMatchesServicePrefix } from './group-path-utils.js';
