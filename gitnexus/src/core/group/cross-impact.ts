/**
 * Cross-repo impact (Phase 1 local walk + Phase 2 bridge fan-out).
 * All bridge Cypher for this feature lives in this module.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ImpactRisk } from 'gitnexus-shared';
import type {
  BridgeHandle,
  BridgeMeta,
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
import {
  bridgeMetaMatchesFile,
  closeBridgeDb,
  getCachedBridgeReadOnly,
  queryBridge,
  readBridgeMeta,
} from './bridge-db.js';
import { BRIDGE_SCHEMA_VERSION } from './bridge-schema.js';
// Re-exported so the three surfaces keep one import site for the vocabulary,
// while the fold itself stays in a leaf module no native binding reaches.
export {
  truncationFields,
  crossRepoCompleteness,
  type TruncationFields,
  type CrossRepoCompleteness,
  type CrossRepoCompletenessInput,
} from './completeness.js';
import { truncationFields, crossRepoCompleteness } from './completeness.js';
import { compareCodeUnits } from '../../lib/utils.js';

// High limit for the local phase of group impact so collectImpactSymbolUids
// sees (nearly) all symbols. Bypasses the MCP-facing default of 100.
const GROUP_LOCAL_PHASE_LIMIT = 10000;

/** Cross-boundary hops beyond this value are clamped (multi-hop reserved for future work). */
export const MAX_SUPPORTED_CROSS_DEPTH = 1;

/** Default wall-clock budget for the Phase 1 `impact` leg when callers omit `timeoutMs`. */
export const DEFAULT_LOCAL_IMPACT_TIMEOUT_MS = 30_000;

/**
 * Cap on neighbour fan-outs attempted per group-impact request.
 *
 * The bound used to be the wall clock alone, which made the cutoff a function
 * of machine load: an idle host traversed more crossings and `mergeRisk`
 * escalated to CRITICAL at three, while a loaded host stopped at two and
 * reported HIGH or lower — same graph, same arguments, different verdict
 * (#2787). A count is deterministic, and the neighbour list carries a total
 * order over the full crossing identity (confidence DESC, then repo, uid,
 * contract), so the cap keeps the strongest crossings rather than an arbitrary
 * prefix.
 *
 * 50 is borrowed from `MAX_CROSSINGS_TO_TRY` (cross-trace.ts) on cost, not on
 * scope — that one caps ContractLinks per repo pair inside a trace, this one
 * caps the total across all neighbour repos in one impact call, and group impact
 * had no numeric cap at all before #2787. The wall clock stays as a hang
 * backstop below; this is the bound that normally binds.
 */
export const MAX_NEIGHBOR_FANOUT = 50;

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

export type BridgeNeighborRow = {
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
    const matchingMemberPaths = Object.entries(config.repos)
      .filter(([, alias]) => alias.toLowerCase() === repoPath.toLowerCase())
      .map(([memberPath]) => memberPath);
    if (matchingMemberPaths.length > 0) {
      return {
        error:
          `Unknown repo path "${repoPath}" in this group. ` +
          `That value is a registry alias for member path(s): ${matchingMemberPaths.join(', ')}. ` +
          `Pass the group.yaml key to --repo, not the alias.`,
      };
    }
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

// Exported so the U4 PDG-result interchangeability contract (KTD8) can assert
// permanently that a PDG `risk:'UNKNOWN'` never coalesces to a confident `LOW`.
// No behavior change — `'UNKNOWN'` was already handled correctly at the
// `(localRisk === 'LOW' || localRisk === 'UNKNOWN')` branch below.
function asImpactRisk(value: unknown, fallback: ImpactRisk = 'LOW'): ImpactRisk {
  return value === 'LOW' ||
    value === 'MEDIUM' ||
    value === 'HIGH' ||
    value === 'CRITICAL' ||
    value === 'UNKNOWN'
    ? value
    : fallback;
}

export function mergeRisk(localRisk: ImpactRisk, cross: CrossRepoImpact[]): ImpactRisk {
  const traversed = cross.filter((c) => c.fanout_status !== 'not_attempted');
  const highConf = traversed.some((c) => c.contract.confidence >= 0.85);
  if (localRisk === 'CRITICAL') return 'CRITICAL';
  if (traversed.length >= 3) return 'CRITICAL';
  if (highConf) return 'HIGH';
  if (traversed.length > 0 && (localRisk === 'LOW' || localRisk === 'UNKNOWN')) return 'MEDIUM';
  return localRisk;
}

function liftLocalRiskMeta(
  local: unknown,
  cross: CrossRepoImpact[],
): Pick<GroupImpactResult, 'riskSharedAxes' | 'riskScale'> {
  const { riskSharedAxes, riskScale } = local as {
    riskSharedAxes?: unknown;
    riskScale?: GroupImpactResult['riskScale'];
  };
  return {
    ...(riskSharedAxes !== undefined
      ? { riskSharedAxes: mergeRisk(asImpactRisk(riskSharedAxes), cross) }
      : {}),
    ...(riskScale !== undefined ? { riskScale } : {}),
  };
}

/**
 * Is this bridge's metadata unable to say where its contents came from?
 *
 * The three reads are all about a `BridgeMeta` and stay OUT of
 * `crossRepoCompleteness` on purpose (see its doc): they are how a caller that
 * opened a bridge computes `provenanceUnknown`, not how every caller does.
 *
 *   - `version === 0` — no readable meta.json at all (`readBridgeMeta` answers
 *     that for both "absent" and "unparseable");
 *   - `repoListsUnreadable` — a meta.json that parsed but whose repo lists are
 *     not repo lists. A value we could not read is not a measurement of zero,
 *     so it may not be spent as one;
 *   - `pairedWithDatabase === false` — a meta.json that does not describe the
 *     database sitting beside it, which is what a sync interrupted between the
 *     swap and the metadata write leaves behind. Measured by
 *     `ensureBridgeReady` BEFORE the database is opened and carried on the
 *     meta; this only reads the answer (#3012).
 *
 * Treating any of them as complete is the fail-open the completeness channel
 * exists to close.
 */
export function bridgeProvenanceUnknown(meta: BridgeMeta): boolean {
  return (
    meta.version === 0 || meta.repoListsUnreadable === true || meta.pairedWithDatabase === false
  );
}

function addCrossImpact(cross: CrossRepoImpact[], candidate: CrossRepoImpact): void {
  const sameBoundary = (entry: CrossRepoImpact): boolean =>
    entry.repo_path === candidate.repo_path && entry.contract.id === candidate.contract.id;

  if (candidate.fanout_status === 'not_attempted') {
    if (cross.some(sameBoundary)) return;
  } else {
    const boundaryOnlyIndex = cross.findIndex(
      (entry) => sameBoundary(entry) && entry.fanout_status === 'not_attempted',
    );
    if (boundaryOnlyIndex >= 0) cross.splice(boundaryOnlyIndex, 1);
  }

  cross.push(candidate);
}

export async function ensureBridgeReady(
  groupDir: string,
): Promise<{ handle: BridgeHandle; meta: BridgeMeta } | { error: string }> {
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
  // Pair the metadata to the database BEFORE opening it, and carry the answer.
  // An unstamped pair is judged on the two files' write order, so any open that
  // touched `bridge.lbug`'s mtime would silently convert "legacy but intact"
  // into "provenance unknown" for every pre-stamp bridge on that platform. This
  // ordering removes the question rather than betting on the answer.
  meta.pairedWithDatabase = await bridgeMetaMatchesFile(groupDir, meta);

  // Use the cached read-only handle if available — avoids reopening the same
  // bridge.lbug in a long-lived MCP server, which fails on Windows because
  // the OS handle isn't fully released before the next open races in.
  const handle = await getCachedBridgeReadOnly(groupDir);
  if (!handle) {
    return {
      error: `Could not open bridge.lbug read-only (schema ${BRIDGE_SCHEMA_VERSION}). Run gitnexus group sync.`,
    };
  }
  return { handle, meta };
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

/**
 * Resolve cross-repo neighbors over `ContractLink` for a set of local symbol
 * UIDs, in a single direction, sorted by descending confidence.
 *
 * This is the one shared consumer↔provider bridge join. `runGroupImpact`'s
 * Phase-2 fan-out uses it directly; the cross-repo trace path (`cross-trace.ts`)
 * reuses the same `queryBridge` + row-normalization primitives but issues a
 * distinct *pair* query, because a trace must keep BOTH endpoints of a crossing
 * (this neighbor join intentionally returns only the far side, which is lossy
 * for stitching a path). Keeping this helper as the single uid-filtered join
 * means impact never forks its own copy of the neighbor Cypher.
 *
 * Returns `[]` for an empty `uids` set without touching the DB.
 */
export async function resolveBridgeNeighbors(
  handle: BridgeHandle,
  opts: { localRepo: string; uids: string[]; direction: 'upstream' | 'downstream' },
): Promise<BridgeNeighborRow[]> {
  if (opts.uids.length === 0) return [];
  const cypher = opts.direction === 'upstream' ? CY_NEIGHBORS_UPSTREAM : CY_NEIGHBORS_DOWNSTREAM;
  const rows = await queryBridge<Record<string, unknown>>(handle, cypher, {
    localRepo: opts.localRepo,
    uids: opts.uids,
  });
  const neighbors: BridgeNeighborRow[] = [];
  for (const raw of rows) {
    const n = rowToNeighbor(raw);
    if (n) neighbors.push(n);
  }
  // Sort on the FULL crossing identity — the same triple the fan-out dedups on
  // below (`repo\0uid\0contractId`). Two links that share (confidence, repo,
  // uid) but differ in contract both survive that dedup, so leaving contractId
  // out of the comparator makes them compare 0 and fall back to raw bridge row
  // order, which is what decides who lands past MAX_NEIGHBOR_FANOUT (#2787).
  neighbors.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      compareCodeUnits(a.neighborRepo, b.neighborRepo) ||
      compareCodeUnits(a.neighborUid, b.neighborUid) ||
      compareCodeUnits(a.contractId, b.contractId),
  );
  return neighbors;
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
    limit: GROUP_LOCAL_PHASE_LIMIT,
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
      ...truncationFields(true, 'timeout'),
      truncatedRepos: [],
      summary: {
        direct: 0,
        processes_affected: 0,
        modules_affected: 0,
        cross_repo_hits: 0,
      },
      risk: 'UNKNOWN',
      ...liftLocalRiskMeta(local, []),
      timeoutMs,
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
        ...truncationFields(false),
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
      ...truncationFields(Boolean((local as { partial?: boolean }).partial), 'partial'),
      truncatedRepos: [],
      summary: {
        direct: s.direct ?? 0,
        processes_affected: s.processes_affected ?? 0,
        modules_affected: s.modules_affected ?? 0,
        cross_repo_hits: 0,
      },
      risk: asImpactRisk((local as { risk?: unknown }).risk),
      ...liftLocalRiskMeta(local, []),
      timeoutMs,
      crossDepthWarning,
    };
  }

  const bridgePrep = await ensureBridgeReady(groupDir);
  if ('error' in bridgePrep) return { error: bridgePrep.error };

  const handle = bridgePrep.handle;
  // Repos the sync that built this bridge could not account for. Their
  // contracts — and every cross-link touching them — are simply absent from
  // bridge.lbug, and nothing else in this walk can notice that: the only
  // incompleteness channel on the result is `truncationFields`, driven by
  // fan-out state. Without folding these in, a query about a symbol whose one
  // downstream consumer lives in an unreadable repo returns
  // `{ cross: [], truncated: false }` — "complete: nothing depends on this" —
  // which is a wrong answer, not an empty one, for a tool an agent uses to
  // license a delete or a rename.
  //
  // The metadata read that answers it (`bridgeProvenanceUnknown`) happens
  // INSIDE the `try` below, and the flag is initialized fail-closed here only
  // because it outlives that block. The lease taken by `ensureBridgeReady` is
  // released by the `finally` and nowhere else, so work done between the lease
  // and the `try` is work whose every throw leaks a refcount the cached handle
  // can never get back — which is how a malformed meta.json used to wedge the
  // handle as well as crash the query. (The repo lists are folded in after the
  // `finally`, where a throw can no longer strand the lease.)
  let provenanceUnknown = true;
  const cross: CrossRepoImpact[] = [];
  const outOfScope: OutOfScopeLink[] = [];
  const truncatedRepos: string[] = [];
  /** Real `impactByUid` fan-outs issued — what MAX_NEIGHBOR_FANOUT bounds. */
  let attemptedFanouts = 0;
  /** True when the wall-clock backstop, not the count cap, cut the fan-out. */
  let fanoutTimedOut = false;

  try {
    provenanceUnknown = bridgeProvenanceUnknown(bridgePrep.meta);

    const neighbors = await resolveBridgeNeighbors(handle, {
      localRepo: repoPath,
      uids,
      direction,
    });

    const seen = new Set<string>();

    for (const n of neighbors) {
      const manifestOnly = n.neighborUid.startsWith('manifest::');
      if (
        servicePrefix &&
        !manifestOnly &&
        !fileMatchesServicePrefix(n.neighborFilePath, servicePrefix)
      ) {
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

      // Deterministic bound first: the count decides the cutoff on every host.
      // Manifest-only crossings are exempt because they cost no `impactByUid`
      // and dropping them regresses #2784.
      if (!manifestOnly && attemptedFanouts >= MAX_NEIGHBOR_FANOUT) {
        truncatedRepos.push(n.neighborRepo);
        continue;
      }
      // Wall clock second, as a hang backstop only. It is load-dependent by
      // construction, so when it is what fired the response must say `timeout`,
      // not the generic `partial` it used to report.
      if (!manifestOnly && deadline - Date.now() <= 0) {
        fanoutTimedOut = true;
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

      // A manifest link can prove the repository boundary even when its far
      // endpoint has no graph symbol of its own (for example, a string-based
      // RPC dispatch). Those endpoints deliberately use a deterministic
      // `manifest::...` UID. Calling impactByUid with that synthetic value can
      // never succeed because it is not a node in the verified neighbor
      // repository; dropping the crossing here made `group sync` report the
      // manifest link while `group impact` silently returned cross=0 (#2722).
      //
      // Preserve the proven crossing with an empty local fan-out. Real UIDs
      // still take the normal impactByUid path below, where failures remain
      // truncations rather than false successful traversals.
      if (manifestOnly) {
        addCrossImpact(cross, {
          repo: regName,
          repo_path: n.neighborRepo,
          contract: {
            id: n.contractId,
            type: n.contractType as ContractType,
            match_type: 'manifest',
            confidence: n.confidence,
          },
          by_depth: {},
          affected_processes: [],
          fanout_status: 'not_attempted',
        });
        continue;
      }

      const remainingMs = deadline - Date.now();
      // Phase-2 hardening: race each impactByUid against a per-call
      // timeout derived from the remaining budget. Without this wrap a
      // single hung neighbor would pin the request past the clamped
      // timeout, which Codex's adversarial review on PR #1331 flagged
      // as the still-open half of CodeQL #184 / js/resource-exhaustion.
      attemptedFanouts += 1;
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
        if (neighborTimedOut) fanoutTimedOut = true;
        truncatedRepos.push(n.neighborRepo);
        continue;
      }

      addCrossImpact(cross, {
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
  const localRisk = asImpactRisk((local as { risk?: unknown }).risk);
  const localPartial = Boolean((local as { partial?: boolean }).partial);
  // The bridge's own incompleteness, in the shared vocabulary, read through
  // what this query DECLARED. The fan-out above already drops every neighbour
  // outside `subgroup`, so an incomplete repo the query excluded could not have
  // contributed a crossing to this answer — marking the answer a floor because
  // of it makes the marker fire on results it does not describe, which is how a
  // caller learns to ignore it. An unscoped query passes `subgroup: undefined`,
  // which `repoInSubgroup` answers true for, so the intersection is the whole
  // set and that path is byte-for-byte the old behaviour.
  //
  // The declared scope is the subgroup PLUS the query's own repo (`exact`
  // reuses the one membership helper for the equality, rather than growing a
  // second notion of it): the walk starts from `repoPath`'s contracts in the
  // bridge, so if THAT is the repo the sync could not read there are no
  // crossings to find for any scope, and a subgroup excluding it must not turn
  // that vacuum into a confident "complete".
  //
  // Declared scope, not traversed scope: an incomplete repo's contracts are
  // absent from the bridge by definition, so it is never in the set the walk
  // reached — filtering on what was traversed would empty the intersection on
  // every query and silently restore the fail-open.
  //
  // Sound only while `MAX_SUPPORTED_CROSS_DEPTH` is 1. At depth 2+ an
  // out-of-scope repo can sit BETWEEN two in-scope ones, so dropping it would
  // convert a genuine lower bound into a confident complete answer; widen this
  // predicate in the same change that raises the depth.
  const bridge = crossRepoCompleteness({
    unreadableRepos: bridgePrep.meta.unreadableRepos,
    missingRepos: bridgePrep.meta.missingRepos,
    suppressedMatchStages: bridgePrep.meta.suppressedMatchStages,
    provenanceUnknown,
    inScope: (candidate) =>
      repoInSubgroup(candidate, subgroup) || repoInSubgroup(candidate, repoPath, true),
  });
  // One predicate, read twice below. Written out at both sites, a third runtime
  // cause added to the flag and forgotten at the reason would label a
  // retry-able answer `incomplete-sync` — telling the operator to re-sync for
  // something a retry fixes. That reason-vs-flag drift is what `truncationFields`
  // exists to prevent.
  const runtimeTruncated = truncatedRepos.length > 0 || localPartial;
  const truncated = runtimeTruncated || bridge.truncated;

  const result: GroupImpactResult = {
    local,
    group: name,
    cross,
    outOfScope,
    // The risk VALUE is never clamped down. `mergeRisk` is monotone increasing
    // in the traversed-crossing count, so truncation can only under-report —
    // and under-reporting a blast radius is the unsafe direction (an agent told
    // LOW proceeds; told CRITICAL it stops). Marking the floor keeps the
    // warning intact while making the incompleteness legible.
    // Runtime limits first — they are what the caller can retry. Past those, the
    // BRIDGE's own reason wins: it already distinguished an unreadable repo
    // ('incomplete-sync', remedy: re-sync) from a stage the sync was asked to
    // skip ('suppressed-stage', remedy: re-sync WITHOUT the flag). Hardcoding
    // the fallback here overrode that and told every caller to repair a repo
    // that read fine — and made the second value unreachable from this surface
    // while the tool description promised it. `cross-trace.ts` re-spreads the
    // bridge's fields for the same reason.
    ...truncationFields(
      truncated,
      fanoutTimedOut
        ? 'timeout'
        : runtimeTruncated
          ? 'partial'
          : bridge.truncated
            ? bridge.truncationReason
            : 'incomplete-sync',
    ),
    truncatedRepos: [...new Set([...truncatedRepos, ...bridge.incompleteRepos])],
    summary: {
      direct: localSum.direct ?? 0,
      processes_affected: localSum.processes_affected ?? 0,
      modules_affected: localSum.modules_affected ?? 0,
      cross_repo_hits: cross.length,
    },
    risk: mergeRisk(localRisk, cross),
    ...liftLocalRiskMeta(local, cross),
    timeoutMs,
    crossDepthWarning,
  };
  return result;
}

export { normalizeServicePrefix, fileMatchesServicePrefix } from './group-path-utils.js';
// Re-exported, not redefined: the single definition lives in lib/utils.ts, but
// this module's own surface is what the #2787 regression test imports it from.
export { compareCodeUnits };
