/**
 * Cross-repo call trace — BFS within each repo's LadybugDB, jumping across
 * repos via contracts.json crossLinks.
 *
 * Core module, decoupled from CLI. Consumed by CLI and (future) MCP tool.
 *
 * Algorithm:
 *   1. Load contracts.json for the group (contains crossLinks with
 *      from/to symbolRef.filePath that can be matched against BFS-visited files).
 *   2. In the entry repo, resolve the entry symbol → BFS downstream via CALLS edges.
 *   3. Collect all visited file paths and match against crossLinks where
 *      from.repo == currentRepo and from.symbolRef.filePath is in the visited set.
 *   4. Open the target repo's lbug, resolve the target symbol by name, seed BFS, repeat.
 *   5. Recurse until maxCrossDepth is exhausted or no more hops are found.
 */

import type { ContractType, CrossLink, GroupConfig, MatchType } from './types.js';
import type { GroupRepoHandle, GroupToolPort } from './service.js';
import { GroupNotFoundError, loadGroupConfig } from './config-parser.js';
import { getGroupDir, readContractRegistry } from './storage.js';
import { initLbug, executeParameterized, closeLbug } from '../lbug/pool-adapter.js';
import { logger } from '../logger.js';
import type { SymbolResolver, SymbolCandidate, ResolvedSymbol } from './trace-resolver.js';
import { DefaultSymbolResolver } from './trace-resolver.js';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module-level mtime-based caches (invalidated when file changes on disk)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  mtime: number;
}

const _groupConfigCache = new Map<string, CacheEntry<GroupConfig>>();
const _contractRegistryCache = new Map<
  string,
  CacheEntry<Awaited<ReturnType<typeof readContractRegistry>>>
>();

async function cachedLoadGroupConfig(groupDir: string): Promise<GroupConfig> {
  const filePath = join(groupDir, 'group.yaml');
  try {
    const { mtimeMs } = await stat(filePath);
    const cached = _groupConfigCache.get(groupDir);
    if (cached && cached.mtime === mtimeMs) return cached.value;
    const value = await loadGroupConfig(groupDir);
    _groupConfigCache.set(groupDir, { value, mtime: mtimeMs });
    return value;
  } catch {
    return loadGroupConfig(groupDir);
  }
}

async function cachedReadContractRegistry(groupDir: string) {
  const filePath = join(groupDir, 'contracts.json');
  try {
    const { mtimeMs } = await stat(filePath);
    const cached = _contractRegistryCache.get(groupDir);
    if (cached && cached.mtime === mtimeMs) return cached.value;
    const value = await readContractRegistry(groupDir);
    _contractRegistryCache.set(groupDir, { value, mtime: mtimeMs });
    return value;
  } catch {
    return readContractRegistry(groupDir);
  }
}

export type { SymbolResolver, SymbolCandidate, ResolvedSymbol } from './trace-resolver.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single node visited during intra-repo BFS. */
export interface TraceNode {
  id: string;
  name: string;
  type: string;
  filePath: string;
  depth: number;
  relationType?: string;
  confidence?: number;
}

/** A cross-repo hop discovered during the trace. */
export interface TraceCrossHop {
  contractId: string;
  contractType: ContractType;
  matchType: MatchType;
  linkConfidence: number;
  from: {
    repo: string;
    symbolUid: string;
    symbolName: string;
    symbolFilePath?: string;
  };
  to: {
    repo: string;
    symbolUid: string;
    symbolName: string;
    symbolFilePath?: string;
  };
}

/** One repo's BFS result within the trace. */
export interface TraceRepoSegment {
  repo: string;
  repoPath: string;
  entrySymbolUid: string;
  nodes: TraceNode[];
  crossHops: TraceCrossHop[];
}

/** Full trace result returned to callers. */
export interface TraceResult {
  group: string;
  entryRepo: string;
  entryTarget: string;
  direction: 'downstream' | 'upstream';
  segments: TraceRepoSegment[];
  /** Repos that could not be opened / traversed. */
  skippedRepos: string[];
  /** True when maxCrossDepth was hit before the trace naturally terminated. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Internal options (not part of public API)
// ---------------------------------------------------------------------------

interface SegmentOptions {
  config: GroupConfig;
  deps: TraceDeps;
  crossLinksIndex: CrossLinksIndex;
  direction: 'downstream' | 'upstream';
  maxDepth: number;
  relationTypes: string[];
  includeTests: boolean;
  minConfidence: number;
  openedRepoIds: Set<string>;
  resolver: SymbolResolver;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface TraceParams {
  /** Group name. */
  name: string;
  /** Group repo path (key in group.yaml repos map, e.g. "app/backend"). */
  repo: string;
  /** Symbol name or file path to start the trace from. */
  target: string;
  /** Trace direction — defaults to 'downstream'. */
  direction?: 'downstream' | 'upstream';
  /** Max BFS depth within each repo. 0 = unlimited (BFS runs until frontier is empty). Default: 0. */
  maxDepth?: number;
  /** Max cross-repo hops. 0 = unlimited. Default: 10. */
  maxCrossDepth?: number;
  /** Relation types for BFS edges (default: CALLS). */
  relationTypes?: string[];
  /** Include test files in traversal (default false). */
  includeTests?: boolean;
  /** Minimum edge confidence (0–1, default 0). */
  minConfidence?: number;
}

// ---------------------------------------------------------------------------
// Deps injection (keeps module free of LocalBackend)
// ---------------------------------------------------------------------------

export interface TraceDeps {
  port: GroupToolPort;
  gitnexusDir: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH = 0; // 0 = unlimited (BFS terminates when frontier is empty)
const DEFAULT_MAX_CROSS_DEPTH = 10;
const DEFAULT_RELATION_TYPES = ['CALLS'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @internal exported for testing only */
export function isTestFilePath(fp: string): boolean {
  const lower = fp.toLowerCase();
  return (
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    lower.includes('/__tests__/') ||
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.includes('_test.')
  );
}

// ---------------------------------------------------------------------------
// Generic candidate helpers (framework-agnostic)
// ---------------------------------------------------------------------------

/** @internal exported for testing only */
export function isUtilOrDto(c: SymbolCandidate): boolean {
  const idLower = c.id.toLowerCase();
  const fpLower = (c.filePath || '').toLowerCase();
  const combined = `${idLower}|${fpLower}`;
  return (
    /utils?[./|]/.test(combined) ||
    /enum[./|]/.test(combined) ||
    /validate[./|]/.test(combined) ||
    /convert[./|]/.test(combined) ||
    /dto[./|]/.test(combined) ||
    /entity[./|]/.test(combined) ||
    /\.set[A-Z]/.test(c.id) ||
    /\.get[A-Z]/.test(c.id) ||
    /\.is[A-Z]/.test(c.id)
  );
}

/**
 * Check if a file path belongs to a client/IDL module that is a dead-end for BFS
 * (interface definitions with no CALLS edges).
 * @internal exported for testing only
 */
export function isClientModulePath(filePath: string): boolean {
  if (!filePath) return false;
  const fp = filePath.toLowerCase();
  if (
    fp.includes('-client/') ||
    fp.includes('-client-') ||
    fp.includes('_client/') ||
    fp.includes('/idl/') ||
    fp.endsWith('.thrift')
  )
    return true;
  if (/-api\//.test(fp)) return true;
  if (/[_-]client\d/.test(fp)) return true;
  return false;
}

/**
 * Resolve ALL viable entry symbols for multi-seed BFS.
 * Uses resolver.scoreCandidate and resolver.drillDownToMethod for framework-aware selection.
 */
async function resolveEntrySymbols(
  repoId: string,
  target: string,
  resolver: SymbolResolver,
): Promise<ResolvedSymbol[]> {
  const MAX_SEEDS = 5;
  const SCORE_THRESHOLD_OFFSET = 100;
  const lastDot = target.lastIndexOf('.');
  const preferredMethod = lastDot >= 0 ? target.slice(lastDot + 1) : target;

  const drillDown = (node: SymbolCandidate) =>
    resolver.drillDownToMethod
      ? resolver.drillDownToMethod(repoId, node, preferredMethod)
      : Promise.resolve(node);

  const score = (c: SymbolCandidate, variants?: string[]) =>
    resolver.scoreCandidate ? resolver.scoreCandidate(c, variants, target) : 0;

  // Exact id match — skip scoring
  const exactRows = await executeParameterized(
    repoId,
    `MATCH (n) WHERE n.id = $target
     RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
     LIMIT 1`,
    { target },
  );
  if (exactRows.length > 0) {
    const r = exactRows[0];
    const matched: SymbolCandidate = {
      id: r.id ?? r[0],
      name: r.name ?? r[1],
      type: r.type ?? r[2],
      filePath: r.filePath ?? r[3],
    };
    return [await drillDown(matched)];
  }

  const nameRows = await executeParameterized(
    repoId,
    `MATCH (n) WHERE n.name = $target
     RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath`,
    { target },
  );
  if (nameRows.length === 0) return [];

  const candidates: SymbolCandidate[] = nameRows.map((r: Record<string, unknown>) => ({
    id: (r.id ?? r[0]) as string,
    name: (r.name ?? r[1]) as string,
    type: (r.type ?? r[2]) as string,
    filePath: (r.filePath ?? r[3]) as string,
  }));

  if (candidates.length === 1) return [await drillDown(candidates[0])];

  candidates.sort((a, b) => score(b) - score(a));
  const topScore = score(candidates[0]);
  const scoreThreshold = topScore - SCORE_THRESHOLD_OFFSET;

  const viable = candidates.filter((c) => {
    const s = score(c);
    if (s < scoreThreshold || s < 0) return false;
    if (isTestFilePath(c.filePath)) return false;
    if (isClientModulePath(c.filePath)) return false;
    if (isUtilOrDto(c)) return false;
    return true;
  });

  const pool = viable.length > 0 ? viable : [candidates[0]];

  const results: ResolvedSymbol[] = [];
  const seenIds = new Set<string>();
  for (const c of pool.slice(0, MAX_SEEDS)) {
    const drilled = await drillDown(c);
    if (!seenIds.has(drilled.id)) {
      seenIds.add(drilled.id);
      results.push(drilled);
    }
  }

  if (results.length > 1) {
    logger.info(
      `[trace] resolveEntrySymbols "${target}": ${candidates.length} total, ` +
        `${results.length} seeds: ${results.map((r) => `"${r.id}"`).join(', ')} (threshold=${scoreThreshold})`,
    );
  } else {
    logger.info(
      `[trace] resolveEntrySymbols "${target}": ${candidates.length} candidates, selected "${results[0]?.id}" (score=${topScore})`,
    );
  }

  return results;
}

/**
 * Run BFS within a single repo's lbug graph.
 * Seeds are included in nodes at depth=0. Returns visited nodes and file paths.
 */
async function intraRepoBFS(
  repoId: string,
  seeds: ResolvedSymbol[],
  direction: 'downstream' | 'upstream',
  opts: {
    maxDepth: number;
    relationTypes: string[];
    includeTests: boolean;
    minConfidence: number;
  },
): Promise<{ nodes: TraceNode[]; visitedIds: string[]; visitedFilePaths: Set<string> }> {
  const { maxDepth, relationTypes, includeTests, minConfidence } = opts;
  const relTypeFilter = relationTypes.map((t) => `'${t}'`).join(', ');
  const confidenceFilter = minConfidence > 0 ? ` AND r.confidence >= ${minConfidence}` : '';

  const visited = new Set<string>(seeds.map((s) => s.id));
  const visitedFilePaths = new Set<string>(seeds.filter((s) => s.filePath).map((s) => s.filePath));
  let frontier = seeds.map((s) => s.id);
  // Include seed nodes themselves at depth=0
  const nodes: TraceNode[] = seeds.map((s) => ({ ...s, depth: 0 }));

  for (let depth = 1; (maxDepth === 0 || depth <= maxDepth) && frontier.length > 0; depth++) {
    // Use parameterized query to avoid isWriteQuery false positives when
    // node IDs contain keywords like CREATE, SET, DELETE, etc.
    const query =
      direction === 'downstream'
        ? `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN $idList AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, callee.id AS id, callee.name AS name, labels(callee)[0] AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence`
        : `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN $idList AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, labels(caller)[0] AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence`;

    let related: any[];
    try {
      related = await executeParameterized(repoId, query, { idList: frontier });
    } catch (e) {
      logger.warn(`[trace] BFS query failed at depth ${depth}: ${e}`);
      break;
    }

    const nextFrontier: string[] = [];
    for (const rel of related) {
      const relId = rel.id ?? rel[1];
      const filePath = rel.filePath ?? rel[4] ?? '';
      if (!includeTests && isTestFilePath(filePath)) continue;
      if (visited.has(relId)) continue;

      visited.add(relId);
      if (filePath) visitedFilePaths.add(filePath);
      nextFrontier.push(relId);

      const relationType = rel.relType ?? rel[5];
      const storedConf = rel.confidence ?? rel[6];
      const effectiveConf = typeof storedConf === 'number' && storedConf > 0 ? storedConf : 1;

      nodes.push({
        id: relId,
        name: rel.name ?? rel[2],
        type: rel.type ?? rel[3],
        filePath,
        depth,
        relationType,
        confidence: effectiveConf,
      });
    }

    frontier = nextFrontier;
  }

  return { nodes, visitedIds: [...visited], visitedFilePaths };
}

// ---------------------------------------------------------------------------
// CrossLinks index — pre-built once per trace for O(1) repo lookup
// ---------------------------------------------------------------------------

/**
 * Pre-indexed crossLinks grouped by (repo, direction-role).
 * For each repo, stores the subset of crossLinks where that repo is the
 * "local endpoint" (the side that matches during hop discovery).
 */
/** @internal exported for testing only */
export interface CrossLinksIndex {
  /** downstream RPC: from.repo → links[] */
  downstreamRpc: Map<string, CrossLink[]>;
  /** upstream RPC: to.repo → links[] */
  upstreamRpc: Map<string, CrossLink[]>;
  /** downstream topic: to.repo → links[] (producer side) */
  downstreamTopic: Map<string, CrossLink[]>;
  /** upstream topic: from.repo → links[] (consumer side) */
  upstreamTopic: Map<string, CrossLink[]>;
}

/** @internal exported for testing only */
export function buildCrossLinksIndex(crossLinks: CrossLink[]): CrossLinksIndex {
  const idx: CrossLinksIndex = {
    downstreamRpc: new Map(),
    upstreamRpc: new Map(),
    downstreamTopic: new Map(),
    upstreamTopic: new Map(),
  };
  for (const link of crossLinks) {
    if (link.type === 'topic') {
      // downstream topic: producer(to) is local → consumer(from) is remote
      const dtKey = link.to.repo;
      if (!idx.downstreamTopic.has(dtKey)) idx.downstreamTopic.set(dtKey, []);
      idx.downstreamTopic.get(dtKey)!.push(link);
      // upstream topic: consumer(from) is local → producer(to) is remote
      const utKey = link.from.repo;
      if (!idx.upstreamTopic.has(utKey)) idx.upstreamTopic.set(utKey, []);
      idx.upstreamTopic.get(utKey)!.push(link);
    } else {
      // downstream RPC: consumer(from) is local → provider(to) is remote
      const drKey = link.from.repo;
      if (!idx.downstreamRpc.has(drKey)) idx.downstreamRpc.set(drKey, []);
      idx.downstreamRpc.get(drKey)!.push(link);
      // upstream RPC: provider(to) is local → consumer(from) is remote
      const urKey = link.to.repo;
      if (!idx.upstreamRpc.has(urKey)) idx.upstreamRpc.set(urKey, []);
      idx.upstreamRpc.get(urKey)!.push(link);
    }
  }
  return idx;
}

/**
 * Find cross-repo hops by matching BFS-visited file paths against
 * contracts.json crossLinks (using pre-built index).
 *
 * For RPC (thrift/http/grpc):
 *   - downstream: from.repo == currentRepo (consumer calls provider)
 *   - upstream: to.repo == currentRepo (provider is called by consumer)
 *
 * For MQ (topic):
 *   - Data flows from producer (to) → consumer (from), opposite to RPC.
 *   - downstream: to.repo == currentRepo (producer sends to consumer)
 *   - upstream: from.repo == currentRepo (consumer receives from producer)
 *
 * Topic hop deduplication: For topic-type crossLinks, multiple consumers in the
 * same target repo (e.g. different consumer groups on the same topic) produce
 * duplicate hops.  We dedup by (contractType, targetRepo) for topics, keeping
 * only the first hop per target repo per topic contractId.
 */
/** @internal exported for testing only */
export function findCrossRepoHopsFromRegistry(
  crossLinksIndex: CrossLinksIndex,
  repoPath: string,
  visitedFilePaths: Set<string>,
  direction: 'downstream' | 'upstream',
): TraceCrossHop[] {
  const hops: TraceCrossHop[] = [];
  const seen = new Set<string>();

  // Gather only the links relevant to this repo+direction from the pre-built index
  const rpcLinks =
    direction === 'downstream'
      ? (crossLinksIndex.downstreamRpc.get(repoPath) ?? [])
      : (crossLinksIndex.upstreamRpc.get(repoPath) ?? []);
  const topicLinks =
    direction === 'downstream'
      ? (crossLinksIndex.downstreamTopic.get(repoPath) ?? [])
      : (crossLinksIndex.upstreamTopic.get(repoPath) ?? []);

  // Process RPC links
  for (const link of rpcLinks) {
    const localEndpoint = direction === 'downstream' ? link.from : link.to;
    const remoteEndpoint = direction === 'downstream' ? link.to : link.from;

    if (remoteEndpoint.repo === repoPath) continue; // skip self-links
    if (!visitedFilePaths.has(localEndpoint.symbolRef.filePath)) continue;

    const key = `${link.contractId}::${repoPath}->${remoteEndpoint.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hops.push({
      contractId: link.contractId,
      contractType: link.type,
      matchType: link.matchType,
      linkConfidence: link.confidence,
      from: {
        repo: link.from.repo,
        symbolUid: link.from.symbolUid,
        symbolName: link.from.symbolRef.name,
        symbolFilePath: link.from.symbolRef.filePath,
      },
      to: {
        repo: link.to.repo,
        symbolUid: link.to.symbolUid,
        symbolName: link.to.symbolRef.name,
        symbolFilePath: link.to.symbolRef.filePath,
      },
    });
  }

  // Process topic/MQ links (match at repo level, no file path check)
  for (const link of topicLinks) {
    const remoteEndpoint = direction === 'downstream' ? link.from : link.to;

    if (remoteEndpoint.repo === repoPath) continue; // skip self-links

    const key = `topic::${link.contractId}::${remoteEndpoint.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hops.push({
      contractId: link.contractId,
      contractType: link.type,
      matchType: link.matchType,
      linkConfidence: link.confidence,
      from: {
        repo: link.from.repo,
        symbolUid: link.from.symbolUid,
        symbolName: link.from.symbolRef.name,
        symbolFilePath: link.from.symbolRef.filePath,
      },
      to: {
        repo: link.to.repo,
        symbolUid: link.to.symbolUid,
        symbolName: link.to.symbolRef.name,
        symbolFilePath: link.to.symbolRef.filePath,
      },
    });
  }

  return hops;
}

// ---------------------------------------------------------------------------
// Segment processing (extracted for parallel execution)
// ---------------------------------------------------------------------------

type QueueItem = {
  repoPath: string;
  symbolName: string;
  crossDepth: number;
  isTopic?: boolean;
  hintFilePath?: string;
};

interface SegmentResult {
  repoPath: string;
  skipped: boolean;
  segment?: TraceRepoSegment;
}

/**
 * Process a single cross-repo segment: resolve repo → init lbug → resolve
 * symbol → BFS → find crossHops.  Does NOT close lbug — caller manages
 * pool lifecycle via openedRepoIds.
 */
async function processOneSegment(item: QueueItem, opts: SegmentOptions): Promise<SegmentResult> {
  const {
    config,
    deps,
    crossLinksIndex,
    direction,
    maxDepth,
    relationTypes,
    includeTests,
    minConfidence,
    openedRepoIds,
    resolver,
  } = opts;
  const regName = config.repos[item.repoPath];
  if (!regName) {
    return { repoPath: item.repoPath, skipped: true };
  }

  let repoHandle: GroupRepoHandle;
  try {
    repoHandle = await deps.port.resolveRepo(regName);
  } catch {
    return { repoPath: item.repoPath, skipped: true };
  }

  // Init lbug
  const dbPath = `${repoHandle.storagePath}/lbug`;
  try {
    await initLbug(repoHandle.id, dbPath);
    openedRepoIds.add(repoHandle.id);
  } catch {
    return { repoPath: item.repoPath, skipped: true };
  }

  try {
    const bfsOpts = { maxDepth, relationTypes, includeTests, minConfidence };
    let nodes: TraceNode[] = [];
    let visitedFilePaths: Set<string> = new Set();
    let entrySymbolUid = item.symbolName;

    const isUnresolvable = resolver.isUnresolvableSymbolName?.bind(resolver) ?? (() => false);
    const resolveCtx = { hintFilePath: item.hintFilePath, isTopic: item.isTopic };

    if (item.isTopic && !isUnresolvable(item.symbolName)) {
      // Topic hop with resolvable symbolName — attempt BFS, fall back to empty segment.
      const targetSym = resolver.resolveSymbolByName
        ? await resolver.resolveSymbolByName(repoHandle.id, item.symbolName, resolveCtx)
        : null;
      if (targetSym) {
        logger.info(`[trace] topic hop resolved "${item.symbolName}" → BFS from ${targetSym.id}`);
        entrySymbolUid = targetSym.id;
        const bfsResult = await intraRepoBFS(repoHandle.id, [targetSym], direction, bfsOpts);
        nodes = bfsResult.nodes;
        visitedFilePaths = bfsResult.visitedFilePaths;
      } else {
        logger.info(
          `[trace] topic hop to "${item.repoPath}" — "${item.symbolName}" not found, empty segment`,
        );
        if (item.hintFilePath) visitedFilePaths.add(item.hintFilePath);
      }
    } else if (item.isTopic) {
      // Unresolvable topic symbolName — seed visitedFilePaths so RPC out-links are discoverable.
      logger.info(
        `[trace] topic hop to "${item.repoPath}" — skipping resolve for "${item.symbolName}"`,
      );
      if (item.hintFilePath) visitedFilePaths.add(item.hintFilePath);
    } else {
      const targetSym = resolver.resolveSymbolByName
        ? await resolver.resolveSymbolByName(repoHandle.id, item.symbolName, resolveCtx)
        : null;
      if (!targetSym) {
        logger.warn(
          `[trace] symbol "${item.symbolName}" not found in "${item.repoPath}", skipping`,
        );
        return { repoPath: item.repoPath, skipped: true };
      }
      entrySymbolUid = targetSym.id;
      const bfsResult = await intraRepoBFS(repoHandle.id, [targetSym], direction, bfsOpts);
      nodes = bfsResult.nodes;
      visitedFilePaths = bfsResult.visitedFilePaths;
    }

    // Find cross-repo hops via pre-built index
    const crossHops = findCrossRepoHopsFromRegistry(
      crossLinksIndex,
      item.repoPath,
      visitedFilePaths,
      direction,
    );

    return {
      repoPath: item.repoPath,
      skipped: false,
      segment: {
        repo: regName,
        repoPath: item.repoPath,
        entrySymbolUid,
        nodes,
        crossHops,
      },
    };
  } finally {
    // Don't close here — trace maintains all opened repos until runGroupTrace
    // completes, then closes them all. LRU eviction handles pool pressure
    // (MAX_POOL_SIZE=5). Some segments may lose their pool entry mid-BFS,
    // causing partial traversal (warn + break) which is acceptable.
  }
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/**
 * Run a cross-repo call trace with the default symbol resolver.
 * Drop-in replacement — existing callers need no changes.
 */
export async function runGroupTrace(
  deps: TraceDeps,
  params: TraceParams,
): Promise<TraceResult | { error: string }> {
  return runGroupTraceWithResolver(deps, params, new DefaultSymbolResolver());
}

/**
 * Run a cross-repo call trace with a custom SymbolResolver.
 * Use this to inject a different framework-awareness strategy without
 * modifying the BFS engine.
 */
export async function runGroupTraceWithResolver(
  deps: TraceDeps,
  params: TraceParams,
  resolver: SymbolResolver,
): Promise<TraceResult | { error: string }> {
  const {
    name,
    repo: entryRepoPath,
    target,
    direction = 'downstream',
    maxDepth = DEFAULT_MAX_DEPTH,
    maxCrossDepth = DEFAULT_MAX_CROSS_DEPTH,
    relationTypes = DEFAULT_RELATION_TYPES,
    includeTests = false,
    minConfidence = 0,
  } = params;

  if (!name) return { error: 'name is required' };
  if (!entryRepoPath) return { error: 'repo is required' };
  if (!target) return { error: 'target is required' };
  if (direction !== 'downstream' && direction !== 'upstream') {
    return { error: 'direction must be downstream or upstream' };
  }

  // Load group config (mtime-cached)
  const groupDir = getGroupDir(deps.gitnexusDir, name);
  let config: GroupConfig;
  try {
    config = await cachedLoadGroupConfig(groupDir);
  } catch (e) {
    if (e instanceof GroupNotFoundError) {
      return { error: `Group "${name}" not found. Run group_list to see configured groups.` };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }

  // Load contracts.json for cross-repo lookups and build index (mtime-cached)
  const registry = await cachedReadContractRegistry(groupDir);
  const crossLinks = registry?.crossLinks ?? [];
  if (crossLinks.length === 0) {
    logger.warn(
      `[trace] No crossLinks in contracts.json for group "${name}". Cross-repo hops disabled.`,
    );
  }
  const crossLinksIndex = buildCrossLinksIndex(crossLinks);

  // Resolve entry repo
  const entryRegistryName = config.repos[entryRepoPath];
  if (!entryRegistryName) {
    return { error: `Unknown repo path "${entryRepoPath}" in group "${name}".` };
  }

  let entryRepo: GroupRepoHandle;
  try {
    entryRepo = await deps.port.resolveRepo(entryRegistryName);
  } catch (e) {
    return { error: `Cannot resolve entry repo: ${e instanceof Error ? e.message : String(e)}` };
  }

  // State
  const segments: TraceRepoSegment[] = [];
  const skippedRepos: string[] = [];
  const visitedRepos = new Set<string>(); // repo + symbolName to avoid cycles
  let truncated = false;

  // Queue: each item is a (repoPath, symbolName) to trace into
  const queue: QueueItem[] = [];

  // Track all opened repos for cleanup at end of trace
  const openedRepoIds = new Set<string>();

  try {
    // --- Phase 1: entry repo ---
    const entryDbPath = `${entryRepo.storagePath}/lbug`;
    await initLbug(entryRepo.id, entryDbPath);
    openedRepoIds.add(entryRepo.id);

    // Resolve entry symbols (multi-seed: all viable implementations)
    const entrySyms = await resolveEntrySymbols(entryRepo.id, target, resolver);
    if (entrySyms.length === 0) {
      return { error: `Symbol "${target}" not found in repo "${entryRepoPath}".` };
    }

    // BFS within entry repo — seed from ALL resolved entry symbols
    const bfsResult = await intraRepoBFS(entryRepo.id, entrySyms, direction, {
      maxDepth,
      relationTypes,
      includeTests,
      minConfidence,
    });
    const entryNodes = bfsResult.nodes;
    const entryVisitedFilePaths = bfsResult.visitedFilePaths;

    // Find cross-repo hops via pre-built index
    const entryCrossHops = findCrossRepoHopsFromRegistry(
      crossLinksIndex,
      entryRepoPath,
      entryVisitedFilePaths,
      direction,
    );

    segments.push({
      repo: entryRegistryName,
      repoPath: entryRepoPath,
      entrySymbolUid: entrySyms[0].id,
      nodes: entryNodes,
      crossHops: entryCrossHops,
    });

    // Enqueue cross-repo targets
    for (const hop of entryCrossHops) {
      const isTopic = hop.contractType === 'topic';
      const targetEndpoint = isTopic
        ? direction === 'downstream'
          ? hop.from
          : hop.to
        : direction === 'downstream'
          ? hop.to
          : hop.from;
      const key = isTopic
        ? `topic::${hop.contractId}::${targetEndpoint.repo}`
        : `${targetEndpoint.repo}::${targetEndpoint.symbolName}`;
      if (!visitedRepos.has(key)) {
        visitedRepos.add(key);
        queue.push({
          repoPath: targetEndpoint.repo,
          symbolName: targetEndpoint.symbolName,
          crossDepth: 1,
          isTopic,
          hintFilePath: targetEndpoint.symbolFilePath,
        });
      }
    }

    // --- Phase 2+: cross-repo BFS (layer-parallel) ---
    // Process segments in parallel batches. PARALLEL_LIMIT=4 leaves 1 pool
    // slot for the entry repo (still in pool from Phase 1). LRU eviction
    // may close idle repos mid-BFS (causing partial traversal at deeper
    // depths) but this is tolerable — the main speedup comes from:
    //   1. CrossLinks index: O(1) repo lookup vs O(N=2354) full scan
    //   2. Parallelism: 4 segments BFS concurrently
    const PARALLEL_LIMIT = 4;

    while (queue.length > 0) {
      // Drain current layer (all items at the same crossDepth)
      const currentDepth = queue[0].crossDepth;
      const layer: QueueItem[] = [];
      while (queue.length > 0 && queue[0].crossDepth === currentDepth) {
        layer.push(queue.shift()!);
      }

      if (maxCrossDepth > 0 && currentDepth > maxCrossDepth) {
        truncated = true;
        continue; // skip entire layer
      }

      // Group layer items by repoPath to batch-process same-repo items together.
      // This avoids redundant initLbug/eviction cycles: all items for a given
      // repo share one init, and different repo-groups run in parallel batches.
      const repoGroups = new Map<string, QueueItem[]>();
      for (const item of layer) {
        const existing = repoGroups.get(item.repoPath);
        if (existing) existing.push(item);
        else repoGroups.set(item.repoPath, [item]);
      }
      const groupKeys = [...repoGroups.keys()];

      // Process repo-groups in parallel batches of PARALLEL_LIMIT.
      // Each group may contain multiple items for the same repo — they are
      // processed sequentially within the group (single init, multiple BFS).
      for (let batchStart = 0; batchStart < groupKeys.length; batchStart += PARALLEL_LIMIT) {
        const batchKeys = groupKeys.slice(batchStart, batchStart + PARALLEL_LIMIT);

        const batchResults = await Promise.all(
          batchKeys.map(async (repoPath) => {
            const items = repoGroups.get(repoPath)!;
            const results: SegmentResult[] = [];
            for (const item of items) {
              results.push(
                await processOneSegment(item, {
                  config,
                  deps,
                  crossLinksIndex,
                  direction,
                  maxDepth,
                  relationTypes,
                  includeTests,
                  minConfidence,
                  openedRepoIds,
                  resolver,
                }),
              );
            }
            return results;
          }),
        );

        // Collect results and enqueue next-layer items
        for (const groupResults of batchResults) {
          for (const result of groupResults) {
            if (result.skipped) {
              skippedRepos.push(result.repoPath);
              continue;
            }
            if (result.segment) {
              segments.push(result.segment);
            }
            // Enqueue further cross-repo targets for the NEXT layer
            for (const hop of result.segment?.crossHops ?? []) {
              const isTopicHop = hop.contractType === 'topic';
              const nextEndpoint = isTopicHop
                ? direction === 'downstream'
                  ? hop.from
                  : hop.to
                : direction === 'downstream'
                  ? hop.to
                  : hop.from;
              const key = isTopicHop
                ? `topic::${hop.contractId}::${nextEndpoint.repo}`
                : `${nextEndpoint.repo}::${nextEndpoint.symbolName}`;
              if (!visitedRepos.has(key)) {
                visitedRepos.add(key);
                queue.push({
                  repoPath: nextEndpoint.repo,
                  symbolName: nextEndpoint.symbolName,
                  crossDepth: currentDepth + 1,
                  isTopic: isTopicHop,
                  hintFilePath: nextEndpoint.symbolFilePath,
                });
              }
            }
          }
        }
      }
    }
  } finally {
    // Close all lbug connections opened during this trace
    for (const rid of openedRepoIds) {
      await closeLbug(rid).catch(() => {});
    }
  }

  // Filter out repos that actually produced segments (avoid false "skipped" reports
  // when a repo is entered multiple times with different symbols — some succeed, some fail).
  const reposWithSegments = new Set(segments.map((s) => s.repoPath));
  const actuallySkipped = [...new Set(skippedRepos)].filter((r) => !reposWithSegments.has(r));

  return {
    group: name,
    entryRepo: entryRepoPath,
    entryTarget: target,
    direction,
    segments,
    skippedRepos: actuallySkipped,
    truncated,
  };
}
