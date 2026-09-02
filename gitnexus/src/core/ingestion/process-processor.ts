/**
 * Process Detection Processor
 *
 * Detects execution flows (Processes) in the code graph by:
 * 1. Finding entry points (functions with no internal callers)
 * 2. Tracing forward via CALLS edges (DFS)
 * 3. Grouping and deduplicating similar paths
 * 4. Labeling with heuristic names
 *
 * Processes help agents understand how features work through the codebase.
 */

import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import { KnowledgeGraph } from '../graph/types.js';
import { CommunityMembership } from './community-processor.js';
import { calculateEntryPointScore, isTestFile } from './entry-point-scoring.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { isDev } from './utils/env.js';

import { logger } from '../logger.js';
// ============================================================================
// CONFIGURATION
// ============================================================================

export interface ProcessDetectionConfig {
  maxTraceDepth: number; // Maximum steps to trace (default: 10)
  maxBranching: number; // Max branches to follow per node (default: 3)
  maxProcesses: number; // Maximum processes to detect (default: 50)
  minSteps: number; // Minimum steps for a valid process (default: 2)
}

const DEFAULT_CONFIG: ProcessDetectionConfig = {
  maxTraceDepth: 10,
  maxBranching: 4,
  maxProcesses: 75,
  minSteps: 3, // 3+ steps = genuine multi-hop flow (2-step is just "A calls B")
};

// ============================================================================
// TYPES
// ============================================================================

export interface ProcessNode {
  id: string; // "proc_handleLogin_createSession"
  label: string; // "HandleLogin → CreateSession"
  heuristicLabel: string;
  processType: 'intra_community' | 'cross_community';
  stepCount: number;
  communities: string[]; // Community IDs touched
  entryPointId: string;
  terminalId: string;
  trace: string[]; // Ordered array of node IDs
}

export interface ProcessStep {
  nodeId: string;
  processId: string;
  step: number; // 1-indexed position in trace
}

/**
 * What the detection ceilings dropped, so a partial answer cannot present
 * itself as a complete one.
 *
 * Every field here was previously either a `logger.debug` line or nothing at
 * all: the caps fired, the result came back looking whole, and no consumer
 * could tell. A silently truncating cap reads as "this is everything", which is
 * the same class of confident-empty answer the rest of this work is about.
 * `dispatchFanoutSkipped` / `propertyDispatch.skippedKeys` are the precedent.
 *
 * The counters are kept SEPARATE rather than summed because they mean different
 * things and a reader acts on them differently: unexplored entry points mean
 * whole flows are missing, while a depth-capped trace means a flow is present
 * but shorter than it really is. `truncated` is the single boolean to branch on.
 * That distinction is not decoration — `pipeline-phases/processes.ts` uses it to
 * decide which of these are worth a `warn` and which belong at `debug`.
 *
 * `entryPointCandidatesDropped` was MISSED on the first pass, which is worth
 * recording because the comment deriving `truncated` claimed "a new ceiling
 * added later cannot be forgotten here" while an EXISTING one already had been:
 * `findEntryPoints` ranks every scoring candidate and then keeps 200, so
 * `entryPointsUnexplored` — computed over the list it RETURNS — could only ever
 * see the survivors. On any repository with more than 200 candidate entry
 * points that slice is the dominant ceiling, and it was invisible.
 */
export interface ProcessTruncationStats {
  /** True when any ceiling below fired. */
  truncated: boolean;
  /**
   * Scoring candidates that never reached the trace loop because
   * `findEntryPoints` keeps only the top `ENTRY_POINT_CANDIDATE_LIMIT`.
   * Counted BEFORE the slice, so it sees what `entryPointsFound` cannot.
   */
  entryPointCandidatesDropped: number;
  /** Entry points never traced at all — the trace-collection loop stopped first. */
  entryPointsUnexplored: number;
  /** Entry-point walks abandoned with branches still on the stack. */
  walksCutByBudget: number;
  /** Traces that end at `maxTraceDepth`, i.e. are a PREFIX of a longer flow. */
  tracesDepthCapped: number;
  /** Callees never followed because a call site exceeded `maxBranching`. */
  calleesDropped: number;
  /** Deduplicated traces discarded because `maxProcesses` was already full. */
  processesDropped: number;
}

export interface ProcessDetectionResult {
  processes: ProcessNode[];
  steps: ProcessStep[];
  stats: {
    totalProcesses: number;
    crossCommunityCount: number;
    avgStepCount: number;
    entryPointsFound: number;
    /** Additive — existing consumers read the four counters above unchanged. */
    truncation: ProcessTruncationStats;
  };
}

/** Zeroed counters, mutated in place by the walk. */
const emptyTruncation = (): ProcessTruncationStats => ({
  truncated: false,
  entryPointCandidatesDropped: 0,
  entryPointsUnexplored: 0,
  walksCutByBudget: 0,
  tracesDepthCapped: 0,
  calleesDropped: 0,
  processesDropped: 0,
});

// ============================================================================
// MAIN PROCESSOR
// ============================================================================

/**
 * Detect processes (execution flows) in the knowledge graph
 *
 * This runs AFTER community detection, using CALLS edges to trace flows.
 */
export const processProcesses = async (
  knowledgeGraph: KnowledgeGraph,
  memberships: CommunityMembership[],
  onProgress?: (message: string, progress: number) => void,
  config: Partial<ProcessDetectionConfig> = {},
  /**
   * Places the program reaches outward — fetch calls and ORM queries, each with
   * a file and a line (R3-6). Attributed to their enclosing function to form the
   * sink set; omitted, behaviour is exactly as before.
   */
  outwardActionSites: readonly OutwardActionSite[] = [],
): Promise<ProcessDetectionResult> => {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sinkFunctions = buildSinkFunctionSet(knowledgeGraph, outwardActionSites);
  const isSink = (nodeId: string): boolean => sinkFunctions.has(nodeId);

  onProgress?.('Finding entry points...', 0);

  // Build lookup maps
  const membershipMap = new Map<string, string>();
  memberships.forEach((m) => membershipMap.set(m.nodeId, m.communityId));

  const callsEdges = buildCallsGraph(knowledgeGraph);
  const reverseCallsEdges = buildReverseCallsGraph(knowledgeGraph);
  const nodeMap = new Map<string, GraphNode>();
  for (const n of knowledgeGraph.iterNodes()) nodeMap.set(n.id, n);

  // Declared before Step 1 because `findEntryPoints` has a ceiling of its own
  // (see `ENTRY_POINT_CANDIDATE_LIMIT`) and reports it through the same record.
  const truncation = emptyTruncation();

  // Step 1: Find entry points (functions that call others but have few callers)
  const entryPoints = findEntryPoints(knowledgeGraph, reverseCallsEdges, callsEdges, truncation);

  onProgress?.(`Found ${entryPoints.length} entry points, tracing flows...`, 20);

  onProgress?.(`Found ${entryPoints.length} entry points, tracing flows...`, 20);

  // Step 2: Trace processes from each entry point
  const allTraces: string[][] = [];

  let tracedEntryPoints = 0;
  for (let i = 0; i < entryPoints.length && allTraces.length < cfg.maxProcesses * 2; i++) {
    const entryId = entryPoints[i];
    const traces = traceFromEntryPoint(entryId, callsEdges, cfg, isSink, truncation);
    tracedEntryPoints = i + 1;

    // Filter out traces that are too short
    traces.filter((t) => t.length >= cfg.minSteps).forEach((t) => allTraces.push(t));

    if (i % 10 === 0) {
      onProgress?.(
        `Tracing entry point ${i + 1}/${entryPoints.length}...`,
        20 + (i / entryPoints.length) * 40,
      );
    }
  }
  // The loop exits on the TRACE quota, not on running out of entry points, so
  // the remainder are not "no flows found" — they were never looked at.
  //
  // Counted over the list `findEntryPoints` RETURNS, which is already capped at
  // `ENTRY_POINT_CANDIDATE_LIMIT`; candidates beyond that cap are invisible here
  // by construction and are reported separately as
  // `entryPointCandidatesDropped`.
  truncation.entryPointsUnexplored = entryPoints.length - tracedEntryPoints;

  onProgress?.(`Found ${allTraces.length} traces, deduplicating...`, 60);

  // Step 3: Deduplicate similar traces (subset removal)
  const uniqueTraces = deduplicateTraces(allTraces, isSink);

  // Step 3b: Deduplicate by entry+terminal pair (keep longest path per pair)
  const endpointDeduped = deduplicateByEndpoints(uniqueTraces);

  onProgress?.(
    `Deduped ${uniqueTraces.length} → ${endpointDeduped.length} unique endpoint pairs`,
    70,
  );

  // Step 4: Limit to max processes — deepest first, but ROUND-ROBIN across
  // TERMINALS (R2-3).
  //
  // Ranking was `sort by length` alone, and the top of that list was one
  // behaviour described many ways: measured on the reporting repo, eleven of
  // the top fourteen processes were four entry points crossed with three
  // terminals of the same date-window utility cluster — `Handle ->
  // AlignWindowEnd`, `Main -> AlignWindowStart`, `ProcessSymbol ->
  // ResolveGridIntervalMs`. Genuine call chains, but a reader learns one thing
  // from fourteen entries.
  //
  // Keyed on the TERMINAL, not the entry point. Keying on the entry was tried
  // first and made it worse — many files declare a `main`, so each was a
  // distinct entry that round-robin then awarded its own slot, and
  // `Main -> AlignWindowEnd` went from one row to eight. The repetition was
  // never in where a flow starts; it is in where flows pile up.
  //
  // Depth still orders within a terminal and still leads the list, since
  // insertion order here is deepest-first. What changes is that no terminal
  // takes a second slot until every other has had a first. Measured: distinct
  // terminals in the top 20 went 3 -> 20, and the repo's own domain flows
  // (`ReconcilePositions -> ...`) moved into the top 4%.
  //
  // What this does NOT do, recorded so it does not read as settled: the
  // reported cause — ranking rewarding fan-in, promoting chains ending in
  // widely-called helpers — measured FALSE. Those terminals have one caller
  // each (`alignWindowStart` 1, `validateSymbol` 1). A fan-in discount was
  // implemented against that hypothesis and moved nothing.
  //
  // R3-6 adds one rule ahead of depth: a SINK-terminated trace outranks a
  // leaf-terminated one. A flow that ends where the program does something —
  // places an order, writes a row — is what a reader came for; a chain that
  // ends in a date helper is where control happened to stop. Depth still orders
  // within each group.
  //
  // This is what closed the gap that used to be described here as out of reach:
  // a business flow could not be a process in its own right, because the walk
  // emitted only at a leaf, at max depth, or on a cycle, so a flow whose
  // meaningful endpoint calls onward survived only as whatever leaf it bottomed
  // out in. Ranking could never fix it — the flow was not a candidate to rank.
  // It is bounded honestly rather than fully closed: sinks are exactly where
  // fetch/ORM extraction fires (see `buildSinkFunctionSet`), so a codebase whose
  // outward calls are not detected as such still sees leaf-terminated traces
  // only.
  // DETERMINISM. The comparator below ranks by sink-ness then by depth, and for
  // two flows equal on both it returned 0. `Array.prototype.sort` is stable, so
  // a 0 preserves INPUT order — which traces back to `graph.iterNodes()`, i.e.
  // the order files happened to be inserted. Under `maxProcesses` capping that
  // decided which `Process` and `STEP_IN_PROCESS` nodes were persisted at all.
  //
  // Reproduced: two equal three-step flows with `maxProcesses: 1` select
  // `handleAlpha`; inserting the identical nodes and CALLS edges in reverse
  // select `handleBeta`. Same repository, same commit, different persisted
  // graph — so an incremental run that reorders assembly, or a filesystem that
  // enumerates differently, silently changes what the tool reports.
  //
  // The id is the tiebreak because it is the only totally-ordered, content-derived
  // key available here; comparing the whole path keeps it stable when two traces
  // share a terminal.
  //
  // MUTATION STATUS, recorded so nobody mistakes this for a verified guard:
  // removing THIS tiebreak alone fails nothing, because the two dedup sorts
  // below already impose a total order on the list that reaches here. The
  // entry-point sort and the dedup sorts each ARE individually verified. This
  // one is kept as defence in depth — it cannot misbehave (it only makes an
  // already-deterministic order explicit) and it is what stops a future change
  // to dedup ordering from silently re-opening the defect.
  //
  // Decorated once and sorted on the precomputed key rather than joining inside
  // the comparator — see `traceOrderKey` for why the key exists at all and
  // `sortByDepthThenPath` for why it is built exactly once per trace. The sink
  // test is hoisted for the same reason: it ran twice per comparison.
  const tracesByTerminal = new Map<string, string[][]>();
  const rankedByInterest = ((): string[][] => {
    const decorated = endpointDeduped.map((trace) => ({
      trace,
      sink: isSink(trace[trace.length - 1] ?? '') ? 1 : 0,
      key: traceOrderKey(trace),
    }));
    decorated.sort(
      (a, b) =>
        b.sink - a.sink || b.trace.length - a.trace.length || compareOrderKeys(a.key, b.key),
    );
    return decorated.map((d) => d.trace);
  })();
  for (const trace of rankedByInterest) {
    const terminalId = trace[trace.length - 1];
    if (terminalId === undefined) continue;
    const existing = tracesByTerminal.get(terminalId);
    if (existing === undefined) tracesByTerminal.set(terminalId, [trace]);
    else existing.push(trace);
  }

  // Insertion order is deepest-trace-first, so the round-robin visits terminals
  // in that order too and depth still leads the list.
  const limitedTraces: string[][] = [];
  for (let round = 0; limitedTraces.length < cfg.maxProcesses; round++) {
    let addedAny = false;
    for (const traces of tracesByTerminal.values()) {
      const trace = traces[round];
      if (trace === undefined) continue;
      limitedTraces.push(trace);
      addedAny = true;
      if (limitedTraces.length >= cfg.maxProcesses) break;
    }
    if (!addedAny) break;
  }
  // Counted against the DEDUPED input, not `allTraces`: the difference between
  // those two is deduplication doing its job, which is not truncation.
  const dedupedAvailable = [...tracesByTerminal.values()].reduce((n, t) => n + t.length, 0);
  truncation.processesDropped = dedupedAvailable - limitedTraces.length;

  onProgress?.(`Creating ${limitedTraces.length} process nodes...`, 80);

  // Step 5: Create process nodes
  const processes: ProcessNode[] = [];
  const steps: ProcessStep[] = [];

  limitedTraces.forEach((trace, idx) => {
    const entryPointId = trace[0];
    const terminalId = trace[trace.length - 1];

    // Get communities touched
    const communitiesSet = new Set<string>();
    trace.forEach((nodeId) => {
      const comm = membershipMap.get(nodeId);
      if (comm) communitiesSet.add(comm);
    });
    const communities = Array.from(communitiesSet);

    // Determine process type
    const processType: 'intra_community' | 'cross_community' =
      communities.length > 1 ? 'cross_community' : 'intra_community';

    // Generate label
    const entryNode = nodeMap.get(entryPointId);
    const terminalNode = nodeMap.get(terminalId);
    const entryName = entryNode?.properties.name || 'Unknown';
    const terminalName = terminalNode?.properties.name || 'Unknown';
    const heuristicLabel = `${capitalize(entryName)} → ${capitalize(terminalName)}`;

    const processId = `proc_${idx}_${sanitizeId(entryName)}`;

    processes.push({
      id: processId,
      label: heuristicLabel,
      heuristicLabel,
      processType,
      stepCount: trace.length,
      communities,
      entryPointId,
      terminalId,
      trace,
    });

    // Create step relationships
    trace.forEach((nodeId, stepIdx) => {
      steps.push({
        nodeId,
        processId,
        step: stepIdx + 1, // 1-indexed
      });
    });
  });

  onProgress?.('Process detection complete!', 100);

  // Calculate stats
  const crossCommunityCount = processes.filter((p) => p.processType === 'cross_community').length;
  const avgStepCount =
    processes.length > 0
      ? processes.reduce((sum, p) => sum + p.stepCount, 0) / processes.length
      : 0;

  // Derived last, from the counters the walk accumulated, so a new ceiling added
  // later cannot be forgotten here — it only has to increment its own counter.
  //
  // That claim was wrong when it was written: `findEntryPoints`' 200-candidate
  // slice was an EXISTING ceiling with no counter, so it was not merely
  // forgettable, it had already been forgotten. Adding a counter is only half
  // the discipline; the other half is checking, when you write a line like this,
  // that every cap in the file actually has one.
  truncation.truncated =
    truncation.entryPointCandidatesDropped > 0 ||
    truncation.entryPointsUnexplored > 0 ||
    truncation.walksCutByBudget > 0 ||
    truncation.tracesDepthCapped > 0 ||
    truncation.calleesDropped > 0 ||
    truncation.processesDropped > 0;

  if (truncation.truncated) {
    logger.debug({ truncation }, 'process-processor: detection was truncated by one or more caps');
  }

  return {
    processes,
    steps,
    stats: {
      totalProcesses: processes.length,
      crossCommunityCount,
      avgStepCount: Math.round(avgStepCount * 10) / 10,
      entryPointsFound: entryPoints.length,
      truncation,
    },
  };
};

// ============================================================================
// HELPER: Build CALLS adjacency list
// ============================================================================

type AdjacencyList = Map<string, string[]>;

/**
 * Minimum edge confidence for process tracing.
 * Filters out ambiguous fuzzy-global matches (0.3) that cause
 * traces to jump across unrelated code areas.
 */
const MIN_TRACE_CONFIDENCE = 0.5;

const buildCallsGraph = (graph: KnowledgeGraph): AdjacencyList => {
  const adj = new Map<string, string[]>();

  // Field-wise scan (#2680) — whole-graph walk, four fields, no object needed.
  graph.forEachRelationshipFields((sourceId, targetId, type, confidence) => {
    if (type !== 'CALLS' || confidence < MIN_TRACE_CONFIDENCE) return;
    const existing = adj.get(sourceId);
    if (existing === undefined) adj.set(sourceId, [targetId]);
    else existing.push(targetId);
  });

  return adj;
};

const buildReverseCallsGraph = (graph: KnowledgeGraph): AdjacencyList => {
  const adj = new Map<string, string[]>();

  graph.forEachRelationshipFields((sourceId, targetId, type, confidence) => {
    if (type !== 'CALLS' || confidence < MIN_TRACE_CONFIDENCE) return;
    const existing = adj.get(targetId);
    if (existing === undefined) adj.set(targetId, [sourceId]);
    else existing.push(sourceId);
  });

  return adj;
};

/**
 * How many ranked candidates survive to be traced. Everything below this line
 * is discarded — see `ProcessTruncationStats.entryPointCandidatesDropped`, the
 * counter that exists because this cap spent a release being invisible.
 */
const ENTRY_POINT_CANDIDATE_LIMIT = 200;

/**
 * Find functions/methods that are good entry points for tracing.
 *
 * Entry points are scored based on:
 * 1. Call ratio (calls many, called by few)
 * 2. Export status (exported/public functions rank higher)
 * 3. Name patterns (handle*, on*, *Controller, etc.)
 *
 * Test files are excluded entirely.
 */
const findEntryPoints = (
  graph: KnowledgeGraph,
  reverseCallsEdges: AdjacencyList,
  callsEdges: AdjacencyList,
  /**
   * Mutated in place when the candidate cap fires. Optional and reported
   * through an out-parameter rather than a richer return value, matching
   * `traceFromEntryPoint`: the `string[]` contract every caller already uses is
   * unchanged, and a caller that does not care about completeness does not have
   * to unwrap a counter to ask for entry points.
   */
  truncation?: ProcessTruncationStats,
): string[] => {
  const symbolTypes = new Set<NodeLabel>(['Function', 'Method']);
  const entryPointCandidates: {
    id: string;
    score: number;
    reasons: string[];
  }[] = [];

  for (const node of graph.iterNodes()) {
    if (!symbolTypes.has(node.label)) continue;

    const filePath = node.properties.filePath || '';

    // Skip test files entirely
    if (isTestFile(filePath)) continue;

    const callers = reverseCallsEdges.get(node.id) || [];
    const callees = callsEdges.get(node.id) || [];

    // Must have at least 1 outgoing call to trace forward
    if (callees.length === 0) continue;

    // Calculate entry point score using new scoring system
    const { score: baseScore, reasons } = calculateEntryPointScore(
      node.properties.name,
      (node.properties.language ?? SupportedLanguages.JavaScript) as SupportedLanguages,
      node.properties.isExported ?? false,
      callers.length,
      callees.length,
      filePath, // Pass filePath for framework detection
    );

    let score = baseScore;
    const astFrameworkMultiplier = node.properties.astFrameworkMultiplier ?? 1.0;
    if (astFrameworkMultiplier > 1.0) {
      score *= astFrameworkMultiplier;
      reasons.push(`framework-ast:${node.properties.astFrameworkReason || 'decorator'}`);
    }

    if (score > 0) {
      entryPointCandidates.push({ id: node.id, score, reasons });
    }
  }

  // Sort by score descending, then by node id. Ties on score are common — most
  // candidates share a heuristic bucket — and a stable sort resolves them by
  // `iterNodes()` order, so which entry points survive the `slice` below became
  // a function of file insertion order. See the determinism note on
  // `rankedByInterest`.
  const sorted = entryPointCandidates.sort(
    (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // DEBUG: Log top candidates with new scoring details
  if (sorted.length > 0 && isDev) {
    logger.info(`[Process] Top 10 entry point candidates (new scoring):`);
    sorted.slice(0, 10).forEach((c, i) => {
      const node = graph.getNode(c.id);
      const exported = node?.properties.isExported ? '✓' : '✗';
      const shortPath = node?.properties.filePath?.split('/').slice(-2).join('/') || '';
      logger.info(`  ${i + 1}. ${node?.properties.name} [exported:${exported}] (${shortPath})`);
      logger.info(`     score: ${c.score.toFixed(2)} = [${c.reasons.join(' × ')}]`);
    });
  }

  // Limit to prevent explosion — and SAY SO. This is the ceiling that decides
  // how much of a repository process detection ever looks at: on anything with
  // more than 200 scoring candidates the reported flows are a sample of the
  // top-ranked ones, and every downstream count (`entryPointsFound`,
  // `entryPointsUnexplored`) is computed over the survivors, so none of them can
  // see what was cut here.
  if (truncation !== undefined && sorted.length > ENTRY_POINT_CANDIDATE_LIMIT) {
    truncation.entryPointCandidatesDropped = sorted.length - ENTRY_POINT_CANDIDATE_LIMIT;
  }

  return sorted.slice(0, ENTRY_POINT_CANDIDATE_LIMIT).map((c) => c.id);
};

// ============================================================================
// HELPER: Trace from entry point (DFS)
// ============================================================================

/**
 * Trace forward from an entry point using DEPTH-first search.
 * Returns all distinct paths up to maxDepth.
 */
// Exported for tests ONLY: traversal order is the whole behaviour here, and it
// is unobservable through `processProcesses` because `findEntryPoints` supplies
// several starting points — a deep chain gets traced from inside it regardless
// of order, so a test at that level passes under either traversal and pins
// nothing.
export const traceFromEntryPoint = (
  entryId: string,
  callsEdges: AdjacencyList,
  config: ProcessDetectionConfig,
  /**
   * Functions that reach outward (R3-6). A trace also ENDS here, even though
   * the walk continues past it: a flow whose meaningful endpoint calls onward
   * was otherwise never a candidate, only ever surviving as whatever leaf it
   * bottomed out in.
   */
  isSink: (nodeId: string) => boolean = () => false,
  /**
   * Mutated in place when a ceiling fires. Optional so the many direct callers
   * in tests are unchanged, and because a caller that does not care about
   * completeness should not have to invent a counter to ask for a trace.
   */
  truncation?: ProcessTruncationStats,
): string[][] => {
  const traces: string[][] = [];

  // DEPTH-first, not breadth-first. Each stack item: [currentNodeId, pathSoFar].
  //
  // The walk stops after a fixed NUMBER of traces, so the traversal order
  // decides which traces those are. Breadth-first reaches every shallow
  // terminal before any deep one, so the quota filled with the shortest paths
  // in the graph and the walk stopped — `maxTraceDepth` was never approached.
  // Measured on a 75k-node repo: of 300 processes, none exceeded 7 steps and
  // 90% were 3-4, so a multi-hop business flow (signal → order → exit) had no
  // process that could represent it, and `query` could only rank the mechanical
  // pairs that did exist.
  //
  // Depth-first descends to a terminal first, so the same quota is spent on
  // paths worth keeping. Cost is unchanged — same budget, same cycle guard,
  // same `maxTraceDepth` ceiling — only the ORDER of exploration differs, and
  // the caller already sorts by length and dedupes by endpoint, so it was
  // always asking for the deepest traces this walk could give it.
  // A LIFO stack, not a queue — the name followed the traversal when this was
  // breadth-first and was left behind by the change to depth-first.
  const stack: [string, string[]][] = [[entryId, [entryId]]];

  const traceBudget = config.maxBranching * 3;
  while (stack.length > 0 && traces.length < traceBudget) {
    const [currentId, path] = stack.pop()!;

    // Get outgoing calls
    const callees = callsEdges.get(currentId) || [];

    if (callees.length === 0) {
      // Terminal node - this is a complete trace
      if (path.length >= config.minSteps) {
        traces.push([...path]);
      }
    } else if (path.length >= config.maxTraceDepth) {
      // Max depth reached - save what we have. The trace is kept, but it is a
      // PREFIX of a longer flow rather than a flow that ended, and only this
      // counter distinguishes the two downstream.
      if (truncation !== undefined) truncation.tracesDepthCapped++;
      if (path.length >= config.minSteps) {
        traces.push([...path]);
      }
    } else {
      // A SINK ends a trace without ending the walk (R3-6). Emitting here is
      // what lets `placeOrder` be an endpoint while `placeOrder -> formatDate`
      // still exists as its own longer trace; the two answer different
      // questions and neither should suppress the other.
      if (isSink(currentId) && path.length >= config.minSteps) {
        traces.push([...path]);
      }
      // Continue tracing - limit branching
      const limitedCallees = callees.slice(0, config.maxBranching);
      if (truncation !== undefined && callees.length > limitedCallees.length) {
        truncation.calleesDropped += callees.length - limitedCallees.length;
      }
      let addedBranch = false;

      // PUSHED IN REVERSE so the stack POPS them in source order. `slice`
      // selects the first N callees while `pop()` takes the last pushed, so
      // without this the walk spends its trace budget on the LAST-declared
      // branch first: for `main() { init(); loadConfig(); run(); shutdown(); }`
      // it explores `shutdown` first and can exhaust the quota before reaching
      // `init` — dropping the earliest steps of a flow, which is the opposite
      // of what a process is meant to describe. Selecting the first N and then
      // exploring them last-first was simply inconsistent.
      for (const calleeId of [...limitedCallees].reverse()) {
        // Avoid cycles
        if (!path.includes(calleeId)) {
          stack.push([calleeId, [...path, calleeId]]);
          addedBranch = true;
        }
      }

      // If all branches were cycles, save current path as terminal
      if (!addedBranch && path.length >= config.minSteps) {
        traces.push([...path]);
      }
    }
  }

  // A silently truncating cap reads as "this is everything", which is the same
  // class of confident-empty answer this work is about. The repo already sets
  // this precedent for `dispatchFanoutSkipped` and
  // `propertyDispatch.skippedKeys`.
  //
  // The debug line stays for the per-entry-point detail (which entry, how many
  // branches); the counter is what escapes to a CONSUMER. A log nobody has
  // enabled is not a disclosure.
  if (stack.length > 0) {
    if (truncation !== undefined) truncation.walksCutByBudget++;
    logger.debug(
      { entryId, traceBudget, unexploredBranches: stack.length },
      'process-processor: trace budget exhausted; unexplored branches remain for this entry point',
    );
  }

  return traces;
};

// ============================================================================
// HELPER: Function-level sink set
// ============================================================================

/** A place in the source where the program reaches outward. */
export interface OutwardActionSite {
  readonly filePath: string;
  readonly lineNumber: number;
}

const CALLABLE_SINK_LABELS: ReadonlySet<NodeLabel> = new Set<NodeLabel>([
  'Function',
  'Method',
  'Constructor',
]);

/**
 * Functions that DO something outward — issue a request, run a query (R3-6).
 *
 * The missing layer behind "business flows are never processes". A trace is
 * only emitted at a node with NO outgoing calls, so a real flow — scan, score,
 * arm, place the order — is always a PREFIX of some longer chain that runs on
 * into date helpers and formatters, and can never be a process in its own
 * right. Ending a trace somewhere meaningful needs a notion of an endpoint that
 * is not a leaf, and the walk had none.
 *
 * GitNexus already knew where the program reaches outward: the parse phase
 * collects fetch calls and ORM queries carrying `filePath` + `lineNumber`. Those
 * facts only ever produced FILE-level edges (`File -[FETCHES]-> Route`), which
 * is too coarse to end a trace on — every function in a file containing one
 * would qualify. Attributing each site to the function whose range CONTAINS it
 * turns the same facts into the function-level signal the walk needs, with no
 * new extraction, no new relation pair, and no schema change.
 *
 * Innermost wins: a nested closure that performs the call is the sink, not the
 * outer function that merely spans it.
 */
export function buildSinkFunctionSet(
  graph: KnowledgeGraph,
  sites: readonly OutwardActionSite[],
): ReadonlySet<string> {
  const sinks = new Set<string>();
  if (sites.length === 0) return sinks;

  const byFile = new Map<string, { id: string; start: number; end: number }[]>();
  for (const node of graph.iterNodes()) {
    if (!CALLABLE_SINK_LABELS.has(node.label)) continue;
    const props = node.properties as { filePath?: string; startLine?: number; endLine?: number };
    if (typeof props.filePath !== 'string') continue;
    if (typeof props.startLine !== 'number' || typeof props.endLine !== 'number') continue;
    const entry = { id: node.id, start: props.startLine, end: props.endLine };
    const list = byFile.get(props.filePath);
    if (list === undefined) byFile.set(props.filePath, [entry]);
    else list.push(entry);
  }

  for (const site of sites) {
    const candidates = byFile.get(site.filePath);
    if (candidates === undefined) continue;
    let best: { id: string; start: number; end: number } | undefined;
    for (const c of candidates) {
      if (site.lineNumber < c.start || site.lineNumber > c.end) continue;
      if (best === undefined || c.end - c.start < best.end - best.start) best = c;
    }
    if (best !== undefined) sinks.add(best.id);
  }
  return sinks;
}

// ============================================================================
// HELPER: Deterministic trace ordering
// ============================================================================

/**
 * Total-order key for a trace — the TIEBREAK every trace sort in this file uses.
 *
 * NUL is the separator, and that is load-bearing rather than cosmetic. Node ids
 * embed file paths and a path may contain a SPACE, so a space-joined key is
 * ambiguous in exactly the way `traceKey`'s unpadded `->` join was (#2894):
 * `['A B', 'C']` and `['A', 'B C']` both render as `A B C`, the comparator
 * returns 0, and `Array.prototype.sort` — being stable — falls straight back to
 * the input order the tiebreak exists to remove. Two of the three trace sorts
 * here joined on a space and had that hole; all three now share this key.
 *
 * NUL cannot occur in a node id (not in a POSIX path, not in a source
 * identifier) and sorts below every character that can, so joining on it is
 * order-equivalent to comparing the two arrays element by element. That
 * equivalence is what makes it a drop-in for the space-joined keys: on any
 * corpus without the collision above the resulting order is IDENTICAL, which is
 * asserted directly in `process-processor.test.ts`.
 */
const traceOrderKey = (trace: readonly string[]): string => trace.join('\u0000');

/** Lexicographic compare of two `traceOrderKey` results. */
const compareOrderKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Sort traces deepest-first, breaking ties on the path key.
 *
 * A Schwartzian transform: the key is built ONCE per trace and the comparator
 * only compares two strings. Written the obvious way — `a.join(sep) <
 * b.join(sep)` inside the comparator — each comparison allocates up to FOUR
 * joined strings, so an O(n log n) sort performs O(n log n) joins of
 * O(depth x id-length) characters each.
 *
 * `n` is bounded here (`ENTRY_POINT_CANDIDATE_LIMIT` entry points x the
 * per-entry trace budget), so the cost is small and once-per-analyze: measured
 * at the ceiling, 23,851 comparisons performed 70,524 joins, and end-to-end
 * `processProcesses` at 80,000 functions / 640k CALLS went 456 -> 555 ms. It is
 * fixed anyway because it is the same allocation-in-the-comparator shape that
 * was just removed from `deduplicateTraces` below (deep_chain 1233 -> 102 ms),
 * and leaving one instance of it standing next to that comment invites the next
 * one.
 */
const sortByDepthThenPath = (traces: readonly string[][]): string[][] => {
  const decorated = traces.map((trace) => ({ trace, key: traceOrderKey(trace) }));
  decorated.sort((a, b) => b.trace.length - a.trace.length || compareOrderKeys(a.key, b.key));
  return decorated.map((d) => d.trace);
};

// ============================================================================
// HELPER: Deduplicate traces
// ============================================================================

/**
 * Merge traces that are subsets of other traces.
 * Keep longer traces, remove redundant shorter ones.
 */
export const deduplicateTraces = (
  traces: string[][],
  /** See `buildSinkFunctionSet` — a sink-terminated trace survives subsumption. */
  isSink: (nodeId: string) => boolean = () => false,
): string[][] => {
  if (traces.length === 0) return [];

  // Sort by length descending, then by path, so equal-length traces have a
  // total order instead of inheriting graph-traversal order (determinism note
  // on `rankedByInterest`). Which of two equal traces is kept as the
  // representative is otherwise decided by insertion order.
  const sorted = sortByDepthThenPath(traces);
  const unique: string[][] = [];
  // Keys for `unique`, built ONCE per surviving trace rather than once per
  // COMPARISON. The join used to sit inside the `some()` callback below, so
  // every already-kept trace had its key rebuilt from scratch against every
  // candidate — O(T*U) joins of O(depth * id-length) characters, and it is that
  // allocation, not the substring scan, that dominates the pass.
  //
  // Nothing about breadth-first search made that safe; it only kept the cost
  // small by keeping traces short. Measured on this repo, the walk went from an
  // average of 4.3 steps to 9.4 when D1 made it depth-first, which roughly
  // doubles both the number of surviving traces and the length of every key —
  // so the same quadratic that was affordable under BFS is ~6x the work under
  // DFS. Hoisting the join removes the multiplication entirely.
  const uniqueKeys: string[] = [];

  for (const trace of sorted) {
    // A SINK-TERMINATED trace is never redundant (R3-6), even though it is by
    // definition a prefix of the longer chain that runs on past the sink into
    // helpers. That is the whole shape of a business flow — scan, score, arm,
    // PLACE THE ORDER — so subsuming it here is exactly what kept such flows
    // from ever being processes. Emitting one at the walk and deleting it one
    // step later would have been a no-op fix.
    const terminal = trace[trace.length - 1];
    // PADDED with the separator on both ends, so `includes` can only match whole
    // steps (#2894). Unpadded, the test is not anchored to a step boundary and a
    // match may begin in the MIDDLE of a node id:
    //
    //   'X->AA->B'.includes('A->B')   ->  true
    //
    // which discards `A -> B` as redundant against a chain `A` is not a step of
    // at all. Measured inert on every corpus tried — the collision needs one id
    // to be a strict suffix of another, which real ids
    // (`Function:<path>:<name>`) do not produce — but the predicate did not mean
    // what the surrounding code says it means, and this is a function whose
    // entire job is deciding what to delete.
    //
    // Note the encoding assumes `->` never appears IN a node id. A C++
    // `operator->` would defeat the join regardless of padding; out of scope
    // here, but the assumption is real.
    const traceKey = `->${trace.join('->')}->`;
    if (terminal !== undefined && isSink(terminal)) {
      unique.push(trace);
      uniqueKeys.push(traceKey);
      continue;
    }
    // Check if this trace is a subset of any already-added trace
    const isSubset = uniqueKeys.some((existingKey) => existingKey.includes(traceKey));

    if (!isSubset) {
      unique.push(trace);
      uniqueKeys.push(traceKey);
    }
  }

  return unique;
};

// ============================================================================
// HELPER: Deduplicate by entry+terminal endpoints
// ============================================================================

/**
 * Keep only the longest trace per unique entry→terminal pair.
 * Multiple paths between the same two endpoints are redundant for agents.
 */
const deduplicateByEndpoints = (traces: string[][]): string[][] => {
  if (traces.length === 0) return [];

  const byEndpoints = new Map<string, string[]>();
  // Sort longest first so the first seen per key is the longest; the path
  // tiebreak makes "which of two equal-length traces represents this endpoint
  // pair" independent of insertion order.
  const sorted = sortByDepthThenPath(traces);

  for (const trace of sorted) {
    const key = `${trace[0]}::${trace[trace.length - 1]}`;
    if (!byEndpoints.has(key)) {
      byEndpoints.set(key, trace);
    }
  }

  return Array.from(byEndpoints.values());
};

// ============================================================================
// HELPER: String utilities
// ============================================================================

const capitalize = (s: string): string => {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const sanitizeId = (s: string): string => {
  return s
    .replace(/[^a-zA-Z0-9]/g, '_')
    .substring(0, 20)
    .toLowerCase();
};
