/**
 * Cross-repo call trace.
 *
 * Stitches per-repo directed-path segments (CALLS + HAS_METHOD, via the
 * existing single-repo `trace`) across a single `ContractLink` boundary in the
 * group bridge, and — when a `--pdg` layer is present and the caller opts in —
 * enriches the boundary-adjacent segments with their intra-procedural
 * REACHING_DEF data-flow.
 *
 * Design notes:
 *  - The crossing is a single bridge hop joined on `symbolUid` (the symbol node
 *    id is the same value the bridge stores as `Contract.symbolUid`). This
 *    mirrors `cross-impact.ts` and is clamped to one boundary
 *    (`MAX_SUPPORTED_CROSS_DEPTH`); multi-hop is deferred.
 *  - All trace-specific bridge Cypher lives in THIS module (mirroring the
 *    "all bridge Cypher for this feature lives here" convention in
 *    cross-impact.ts). The trace needs BOTH endpoints of a crossing to stitch a
 *    path, so it issues its own pair query rather than the lossy uid-filtered
 *    neighbor join exported by cross-impact (`resolveBridgeNeighbors`), which
 *    intentionally returns only the far side.
 *  - PDG is enrichment only: data flow never crosses the repo boundary. Full
 *    cross-program (SDG-like) data flow is deferred — see
 *    docs/plans/2026-06-18-002-feat-unified-pdg-impact-evaluation-plan.md.
 */

import { GroupNotFoundError, loadGroupConfig } from './config-parser.js';
import { getGroupDir } from './storage.js';
import { ensureBridgeReady, MAX_SUPPORTED_CROSS_DEPTH } from './cross-impact.js';
import { closeBridgeDb, queryBridge } from './bridge-db.js';
import type {
  GroupPdgFlowHop,
  GroupRepoHandle,
  GroupSymbolResolution,
  GroupToolPort,
} from './service.js';
import type { BridgeHandle, GroupConfig } from './types.js';

// ── Result types (discriminated on `status`) ─────────────────────────────

export interface TraceHop {
  name: string;
  filePath: string;
  startLine: number;
  /** The member repo path (group.yaml key) this hop belongs to. */
  repo: string;
}

export interface TraceEdge {
  relType: string;
  confidence: number;
}

export interface SegmentDataFlow {
  /** Member repo path of the enriched segment. */
  repo: string;
  /** The boundary-adjacent symbol the flow was anchored on. */
  anchor: string;
  variable?: string;
  hops: GroupPdgFlowHop[];
  truncated?: boolean;
}

export interface BridgeCrossing {
  fromRepo: string;
  toRepo: string;
  contractId: string;
  contractType: string;
  matchType: string;
  confidence: number;
}

export interface GroupTraceEndpoint {
  name: string;
  filePath: string;
  startLine: number;
  repo: string;
}

export interface GroupTraceOkResult {
  status: 'ok';
  group: string;
  from: GroupTraceEndpoint;
  to: GroupTraceEndpoint;
  /** 0 for a same-repo trace, 1 for a single boundary crossing. */
  crossings: BridgeCrossing[];
  hopCount: number;
  hops: TraceHop[];
  edges: TraceEdge[];
  /** Present only when PDG enrichment ran for at least one segment. */
  dataFlow?: SegmentDataFlow[];
  truncated?: boolean;
  notes: string[];
}

export interface GroupTraceCandidate {
  repo: string;
  id: string;
  name: string;
  filePath: string;
  startLine: number;
}

export interface GroupTraceNotFoundResult {
  status: 'not_found';
  group: string;
  role?: 'from' | 'to';
  query?: string;
  notes: string[];
  suggestion?: string;
}

export interface GroupTraceAmbiguousResult {
  status: 'ambiguous';
  group: string;
  role: 'from' | 'to';
  candidates: GroupTraceCandidate[];
  notes: string[];
}

export interface GroupTraceErrorResult {
  status: 'error';
  group: string;
  error: string;
  notes: string[];
}

export type GroupTraceResult =
  | GroupTraceOkResult
  | GroupTraceNotFoundResult
  | GroupTraceAmbiguousResult
  | GroupTraceErrorResult;

/**
 * Centralized degraded-state messages so wording stays consistent and
 * testable. Kept as named constants/builders rather than inline strings.
 */
export const TRACE_NOTES = {
  noBridgeLink:
    'No ContractLink connects the two endpoints across repos — the call chain ' +
    'likely crosses a boundary the group bridge has not linked. Run group_sync, ' +
    'or check that both sides of the contract were extracted.',
  crossDepthClamped:
    `Multi-hop cross-boundary trace is not implemented yet; using a single ` +
    `boundary crossing (crossDepth ${MAX_SUPPORTED_CROSS_DEPTH}).`,
  noLocalPath: (repo: string): string =>
    `No directed CALLS/HAS_METHOD path within ${repo} for the resolved endpoints.`,
  noPdgLayer: (repo: string): string => `No PDG layer in ${repo}; call-level hops only.`,
  pdgRequested:
    'PDG enrichment was requested (experimental). Data-flow hops are intra-procedural ' +
    'and never cross the repo boundary.',
} as const;

export interface RunGroupTraceDeps {
  port: GroupToolPort;
  gitnexusDir: string;
}

// ── Local single-repo trace result narrowing ─────────────────────────────

interface LocalTraceShape {
  status: string;
  from?: { name: string; filePath: string; startLine: number };
  to?: { name: string; filePath: string; startLine: number };
  hopCount?: number;
  hops?: Array<{ name: string; filePath: string; startLine: number }>;
  edges?: Array<{ relType: string; confidence: number }>;
}

function asLocalTrace(raw: unknown): LocalTraceShape | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.status !== 'string') return null;
  return o as unknown as LocalTraceShape;
}

// ── Bridge pair query (trace-specific; keeps BOTH endpoints) ──────────────

const CY_CROSSINGS_BETWEEN = `
MATCH (consumer:Contract)-[l:ContractLink]->(provider:Contract)
WHERE consumer.repo = $fromRepo
  AND provider.repo = $toRepo
  AND consumer.role = 'consumer'
  AND provider.role = 'provider'
RETURN consumer.symbolUid AS consumerUid,
       provider.symbolUid AS providerUid,
       l.matchType AS matchType,
       l.confidence AS confidence,
       l.contractId AS contractId,
       consumer.type AS contractType
`;

interface CrossingRow {
  consumerUid: string;
  providerUid: string;
  matchType: string;
  confidence: number;
  contractId: string;
  contractType: string;
}

function rowToCrossing(r: Record<string, unknown>): CrossingRow | null {
  const consumerUid = String(r.consumerUid ?? r[0] ?? '');
  const providerUid = String(r.providerUid ?? r[1] ?? '');
  if (!consumerUid || !providerUid) return null;
  return {
    consumerUid,
    providerUid,
    matchType: String(r.matchType ?? r[2] ?? 'exact'),
    confidence: Number(r.confidence ?? r[3] ?? 0),
    contractId: String(r.contractId ?? r[4] ?? ''),
    contractType: String(r.contractType ?? r[5] ?? 'custom'),
  };
}

async function listCrossingsBetween(
  handle: BridgeHandle,
  fromRepo: string,
  toRepo: string,
): Promise<CrossingRow[]> {
  const rows = await queryBridge<Record<string, unknown>>(handle, CY_CROSSINGS_BETWEEN, {
    fromRepo,
    toRepo,
  });
  const crossings: CrossingRow[] = [];
  for (const raw of rows) {
    const c = rowToCrossing(raw);
    if (c) crossings.push(c);
  }
  crossings.sort((a, b) => b.confidence - a.confidence);
  return crossings;
}

// ── Cross-member symbol resolution ───────────────────────────────────────

interface MemberHandle {
  repoPath: string;
  registryName: string;
  handle: GroupRepoHandle;
}

interface ResolvedEndpoint {
  member: MemberHandle;
  symbol: { id: string; name: string; filePath: string; startLine: number };
}

type ResolveAcrossOutcome =
  | { kind: 'ok'; endpoint: ResolvedEndpoint }
  | { kind: 'ambiguous'; candidates: GroupTraceCandidate[] }
  | { kind: 'not_found' };

/**
 * Resolve a symbol query across every member repo. Exactly one `ok` match and
 * no per-member ambiguity → resolved. Zero matches → not_found. Anything else
 * (multiple members match, or any member is itself ambiguous) → ambiguous, with
 * every candidate tagged by its repo so the caller can disambiguate.
 */
async function resolveAcrossMembers(
  port: GroupToolPort,
  members: MemberHandle[],
  query: { name?: string; uid?: string; file_path?: string },
): Promise<ResolveAcrossOutcome> {
  const okMatches: ResolvedEndpoint[] = [];
  const ambiguous: GroupTraceCandidate[] = [];

  for (const member of members) {
    // Guarded above by the caller; narrow for the type system.
    const resolveSymbol = port.resolveSymbol;
    if (!resolveSymbol) continue;
    let outcome: GroupSymbolResolution;
    try {
      outcome = await resolveSymbol(member.handle, query);
    } catch {
      continue;
    }
    if (outcome.kind === 'ok') {
      okMatches.push({
        member,
        symbol: {
          id: outcome.symbol.id,
          name: outcome.symbol.name,
          filePath: outcome.symbol.filePath,
          startLine: outcome.symbol.startLine,
        },
      });
    } else if (outcome.kind === 'ambiguous') {
      for (const c of outcome.candidates) {
        ambiguous.push({
          repo: member.repoPath,
          id: c.id,
          name: c.name,
          filePath: c.filePath,
          startLine: c.startLine,
        });
      }
    }
  }

  if (okMatches.length === 1 && ambiguous.length === 0) {
    return { kind: 'ok', endpoint: okMatches[0]! };
  }
  if (okMatches.length === 0 && ambiguous.length === 0) {
    return { kind: 'not_found' };
  }
  // Multiple repos matched, or a member was internally ambiguous: surface all.
  const candidates = [
    ...okMatches.map((m) => ({
      repo: m.member.repoPath,
      id: m.symbol.id,
      name: m.symbol.name,
      filePath: m.symbol.filePath,
      startLine: m.symbol.startLine,
    })),
    ...ambiguous,
  ];
  return { kind: 'ambiguous', candidates };
}

// ── Stitching ────────────────────────────────────────────────────────────

function tagHops(hops: LocalTraceShape['hops'], repo: string): TraceHop[] {
  return (hops ?? []).map((h) => ({
    name: h.name,
    filePath: h.filePath,
    startLine: h.startLine,
    repo,
  }));
}

function endpointFrom(res: ResolvedEndpoint): GroupTraceEndpoint {
  return {
    name: res.symbol.name,
    filePath: res.symbol.filePath,
    startLine: res.symbol.startLine,
    repo: res.member.repoPath,
  };
}

// ── PDG enrichment (U4 hook) ─────────────────────────────────────────────

/**
 * Attach the intra-procedural REACHING_DEF data-flow for a boundary-adjacent
 * segment, when the caller opted in (`pdg:true`) and the repo has a PDG `flows`
 * layer. Returns `undefined` (no enrichment) plus a note when degraded.
 */
async function enrichSegment(
  port: GroupToolPort,
  member: MemberHandle,
  anchorUid: string,
  anchorName: string,
  limit: number,
  notes: string[],
): Promise<SegmentDataFlow | undefined> {
  const pdgFlows = port.pdgFlows;
  if (!pdgFlows) return undefined;
  let flow;
  try {
    flow = await pdgFlows(member.handle, { uid: anchorUid }, { limit });
  } catch {
    return undefined;
  }
  if (!flow.available) {
    notes.push(TRACE_NOTES.noPdgLayer(member.repoPath));
    return undefined;
  }
  if (flow.hops.length === 0) return undefined;
  return {
    repo: member.repoPath,
    anchor: anchorName,
    variable: flow.variable,
    hops: flow.hops,
    truncated: flow.truncated,
  };
}

// ── Param parsing ────────────────────────────────────────────────────────

interface ParsedTraceParams {
  name: string;
  from?: string;
  to?: string;
  from_uid?: string;
  to_uid?: string;
  from_file?: string;
  to_file?: string;
  maxDepth?: number;
  includeTests: boolean;
  pdg: boolean;
  pdgLimit: number;
  /** True when the caller asked for a deeper crossDepth than is supported. */
  crossDepthClamped: boolean;
}

const DEFAULT_PDG_FLOW_LIMIT = 50;
const MAX_PDG_FLOW_LIMIT = 200;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function parseTraceParams(
  params: Record<string, unknown>,
): { ok: true; parsed: ParsedTraceParams } | { ok: false; error: string } {
  const name = String(params.name ?? '').trim();
  if (!name) return { ok: false, error: 'name is required' };
  const from = str(params.from);
  const to = str(params.to);
  const from_uid = str(params.from_uid);
  const to_uid = str(params.to_uid);
  if (!from && !from_uid) return { ok: false, error: 'from (or from_uid) is required' };
  if (!to && !to_uid) return { ok: false, error: 'to (or to_uid) is required' };
  const maxDepth =
    typeof params.maxDepth === 'number' && params.maxDepth > 0 ? params.maxDepth : undefined;
  const rawLimit =
    typeof params.limit === 'number' && params.limit > 0 ? params.limit : DEFAULT_PDG_FLOW_LIMIT;
  const crossDepthClamped =
    typeof params.crossDepth === 'number' &&
    Number.isFinite(params.crossDepth) &&
    Math.floor(params.crossDepth) > MAX_SUPPORTED_CROSS_DEPTH;
  return {
    ok: true,
    parsed: {
      name,
      from,
      to,
      from_uid,
      to_uid,
      from_file: str(params.from_file),
      to_file: str(params.to_file),
      maxDepth,
      includeTests: Boolean(params.includeTests),
      pdg: params.pdg === true,
      pdgLimit: Math.min(rawLimit, MAX_PDG_FLOW_LIMIT),
      crossDepthClamped,
    },
  };
}

// ── Main entry ───────────────────────────────────────────────────────────

export async function runGroupTrace(
  deps: RunGroupTraceDeps,
  params: Record<string, unknown>,
): Promise<GroupTraceResult> {
  const parsedResult = parseTraceParams(params);
  if (parsedResult.ok === false) {
    return {
      status: 'error',
      group: String(params.name ?? ''),
      error: parsedResult.error,
      notes: [],
    };
  }
  const p = parsedResult.parsed;

  if (!deps.port.trace || !deps.port.resolveSymbol) {
    return {
      status: 'error',
      group: p.name,
      error: 'Cross-repo trace is not supported by this backend (trace/resolveSymbol unavailable).',
      notes: [],
    };
  }

  const groupDir = getGroupDir(deps.gitnexusDir, p.name);
  let config: GroupConfig;
  try {
    config = await loadGroupConfig(groupDir);
  } catch (e) {
    if (e instanceof GroupNotFoundError) {
      return {
        status: 'error',
        group: p.name,
        error: `Group "${p.name}" not found. Run group_list to see configured groups.`,
        notes: [],
      };
    }
    return {
      status: 'error',
      group: p.name,
      error: e instanceof Error ? e.message : String(e),
      notes: [],
    };
  }

  // Resolve member handles up front.
  const members: MemberHandle[] = [];
  for (const [repoPath, registryName] of Object.entries(config.repos)) {
    try {
      const handle = await deps.port.resolveRepo(registryName);
      members.push({ repoPath, registryName, handle });
    } catch {
      // A member that can't be resolved is skipped; its absence only matters
      // if an endpoint lived there, which surfaces downstream as not_found.
    }
  }
  if (members.length === 0) {
    return {
      status: 'error',
      group: p.name,
      error: 'No resolvable repos in this group.',
      notes: [],
    };
  }

  const fromOutcome = await resolveAcrossMembers(deps.port, members, {
    name: p.from,
    uid: p.from_uid,
    file_path: p.from_file,
  });
  if (fromOutcome.kind === 'not_found') {
    return {
      status: 'not_found',
      group: p.name,
      role: 'from',
      query: p.from_uid ?? p.from,
      notes: [],
      suggestion:
        'Check the symbol name, pass from_uid for zero-ambiguity, or from_file to narrow.',
    };
  }
  if (fromOutcome.kind === 'ambiguous') {
    return {
      status: 'ambiguous',
      group: p.name,
      role: 'from',
      candidates: fromOutcome.candidates,
      notes: [],
    };
  }

  const toOutcome = await resolveAcrossMembers(deps.port, members, {
    name: p.to,
    uid: p.to_uid,
    file_path: p.to_file,
  });
  if (toOutcome.kind === 'not_found') {
    return {
      status: 'not_found',
      group: p.name,
      role: 'to',
      query: p.to_uid ?? p.to,
      notes: [],
      suggestion: 'Check the symbol name, pass to_uid for zero-ambiguity, or to_file to narrow.',
    };
  }
  if (toOutcome.kind === 'ambiguous') {
    return {
      status: 'ambiguous',
      group: p.name,
      role: 'to',
      candidates: toOutcome.candidates,
      notes: [],
    };
  }

  const fromEp = fromOutcome.endpoint;
  const toEp = toOutcome.endpoint;
  const notes: string[] = [];

  // Same repo → single-repo trace, no crossing.
  if (fromEp.member.repoPath === toEp.member.repoPath) {
    return stitchSameRepo(deps.port, p, fromEp, toEp, notes);
  }

  // Different repos → cross one ContractLink boundary.
  return stitchCrossRepo(deps, p, fromEp, toEp, groupDir, notes);
}

async function stitchSameRepo(
  port: GroupToolPort,
  p: ParsedTraceParams,
  fromEp: ResolvedEndpoint,
  toEp: ResolvedEndpoint,
  notes: string[],
): Promise<GroupTraceResult> {
  const segRaw = await port.trace!(fromEp.member.handle, {
    from_uid: fromEp.symbol.id,
    to_uid: toEp.symbol.id,
    maxDepth: p.maxDepth,
    includeTests: p.includeTests,
  });
  const seg = asLocalTrace(segRaw);
  if (!seg || seg.status !== 'ok') {
    notes.push(TRACE_NOTES.noLocalPath(fromEp.member.repoPath));
    return {
      status: 'not_found',
      group: p.name,
      notes,
      suggestion:
        'Both endpoints resolve in the same repo but no directed path connects them. ' +
        'Try a higher maxDepth or inspect connections with context().',
    };
  }
  const hops = tagHops(seg.hops, fromEp.member.repoPath);
  const edges: TraceEdge[] = (seg.edges ?? []).map((e) => ({
    relType: e.relType,
    confidence: e.confidence,
  }));
  return {
    status: 'ok',
    group: p.name,
    from: endpointFrom(fromEp),
    to: endpointFrom(toEp),
    crossings: [],
    hopCount: edges.length,
    hops,
    edges,
    notes,
  };
}

async function stitchCrossRepo(
  deps: RunGroupTraceDeps,
  p: ParsedTraceParams,
  fromEp: ResolvedEndpoint,
  toEp: ResolvedEndpoint,
  groupDir: string,
  notes: string[],
): Promise<GroupTraceResult> {
  const bridgePrep = await ensureBridgeReady(groupDir);
  if ('error' in bridgePrep) {
    return { status: 'error', group: p.name, error: bridgePrep.error, notes };
  }
  const handle = bridgePrep.handle;

  if (p.crossDepthClamped) notes.push(TRACE_NOTES.crossDepthClamped);
  if (p.pdg) notes.push(TRACE_NOTES.pdgRequested);

  try {
    const crossings = await listCrossingsBetween(
      handle,
      fromEp.member.repoPath,
      toEp.member.repoPath,
    );
    if (crossings.length === 0) {
      notes.push(TRACE_NOTES.noBridgeLink);
      return {
        status: 'not_found',
        group: p.name,
        notes,
        suggestion:
          'The endpoints live in different repos with no ContractLink between them. ' +
          'Run group_sync, or trace within a single repo.',
      };
    }

    // Single boundary crossing (MAX_SUPPORTED_CROSS_DEPTH). Try crossings in
    // confidence order; the first one whose two segments both connect wins.
    for (const crossing of crossings) {
      const segARaw = await deps.port.trace!(fromEp.member.handle, {
        from_uid: fromEp.symbol.id,
        to_uid: crossing.consumerUid,
        maxDepth: p.maxDepth,
        includeTests: p.includeTests,
      });
      const segA = asLocalTrace(segARaw);
      if (!segA || segA.status !== 'ok') continue;

      const segBRaw = await deps.port.trace!(toEp.member.handle, {
        from_uid: crossing.providerUid,
        to_uid: toEp.symbol.id,
        maxDepth: p.maxDepth,
        includeTests: p.includeTests,
      });
      const segB = asLocalTrace(segBRaw);
      if (!segB || segB.status !== 'ok') continue;

      // Found a connecting crossing. Build the stitched path.
      const hopsA = tagHops(segA.hops, fromEp.member.repoPath);
      const hopsB = tagHops(segB.hops, toEp.member.repoPath);
      const edgesA: TraceEdge[] = (segA.edges ?? []).map((e) => ({
        relType: e.relType,
        confidence: e.confidence,
      }));
      const edgesB: TraceEdge[] = (segB.edges ?? []).map((e) => ({
        relType: e.relType,
        confidence: e.confidence,
      }));
      const boundaryEdge: TraceEdge = { relType: 'CONTRACT_LINK', confidence: crossing.confidence };

      const bridgeCrossing: BridgeCrossing = {
        fromRepo: fromEp.member.repoPath,
        toRepo: toEp.member.repoPath,
        contractId: crossing.contractId,
        contractType: crossing.contractType,
        matchType: crossing.matchType,
        confidence: crossing.confidence,
      };

      // PDG enrichment (opt-in): the consumer-side segment ends at the
      // boundary call (anchor = consumer symbol); the provider-side segment
      // begins at the provider entry (anchor = provider symbol).
      const dataFlow: SegmentDataFlow[] = [];
      if (p.pdg) {
        const dfA = await enrichSegment(
          deps.port,
          fromEp.member,
          crossing.consumerUid,
          consumerNameFromHops(hopsA, crossing.consumerUid),
          p.pdgLimit,
          notes,
        );
        if (dfA) dataFlow.push(dfA);
        const dfB = await enrichSegment(
          deps.port,
          toEp.member,
          crossing.providerUid,
          providerNameFromHops(hopsB),
          p.pdgLimit,
          notes,
        );
        if (dfB) dataFlow.push(dfB);
      }

      const edges = [...edgesA, boundaryEdge, ...edgesB];
      const result: GroupTraceOkResult = {
        status: 'ok',
        group: p.name,
        from: endpointFrom(fromEp),
        to: endpointFrom(toEp),
        crossings: [bridgeCrossing],
        hopCount: edges.length,
        hops: [...hopsA, ...hopsB],
        edges,
        notes,
        ...(dataFlow.length > 0 ? { dataFlow } : {}),
      };
      return result;
    }

    // Crossings exist but none connected both segments.
    notes.push(TRACE_NOTES.noBridgeLink);
    return {
      status: 'not_found',
      group: p.name,
      notes,
      suggestion:
        'A ContractLink exists between the repos, but no local path reaches the consumer ' +
        'call site or leaves the provider handler. Try a higher maxDepth.',
    };
  } finally {
    await closeBridgeDb(handle);
  }
}

/** The consumer call site is the last hop of segment A; fall back to the uid. */
function consumerNameFromHops(hopsA: TraceHop[], consumerUid: string): string {
  return hopsA.length > 0 ? hopsA[hopsA.length - 1]!.name : consumerUid;
}

/** The provider handler is the first hop of segment B. */
function providerNameFromHops(hopsB: TraceHop[]): string {
  return hopsB.length > 0 ? hopsB[0]!.name : 'provider';
}
