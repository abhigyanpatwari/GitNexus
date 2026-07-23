/**
 * Phase: moveIngest
 *
 * Compiler-first Move ingestion via the move-flow MCP server. **No raw Move
 * source is ever read.** The `facts` query is the ONLY ingestion path: if the
 * move-flow build doesn't expose it, the phase fails fast with a clear upgrade
 * error before touching any package. Call edges come from the `call_graph`
 * query.
 *
 * Note: move-flow's `facts` query elides all `#[test]` and `#[test_only]`
 * symbols (functions, structs, constants). The graph therefore contains only
 * production symbols; queries to find test functions or exclude tests from
 * impact do not need a symbol-level test filter.
 *
 * @deps    structure
 * @reads   scannedFiles (from structure phase)
 * @writes  graph (Module/Function/Struct/Enum/EnumVariant/Const nodes +
 *          CALLS/DEFINES/CONTAINS/FRIEND_OF/READS_RESOURCE/WRITES_RESOURCE/
 *          ACQUIRES/USES_TYPE/ENTRY_POINT_OF/IMPORTS edges)
 */

import * as path from 'node:path';
import type {
  PipelinePhase,
  PipelineContext,
  PhaseResult,
} from '../ingestion/pipeline-phases/types.js';
import { getPhaseOutput } from '../ingestion/pipeline-phases/types.js';
import type { StructureOutput } from '../ingestion/pipeline-phases/structure.js';
import type { StandaloneIngestOutput } from '../ingestion/pipeline-phases/standalone-ingest.js';
import type { KnowledgeGraph } from '../graph/types.js';
import { moveRepoRelativePath } from './constants.js';
import {
  MoveFlowTimeoutError,
  MoveFlowToolCallError,
  type MoveFlowClient,
  type MovePackageStatus,
} from './mcp-client.js';
import { mapFactsToGraph, type MoveFactsMapResult } from './facts-mapper.js';
import type { CallGraphMap, MoveFactsMap } from './compiler-facts.js';
import { collectClosureCaptureCalls, type FunctionUsageFailure } from './function-usage.js';
import { linkMoveIngestGraph, type MoveLinkState } from './move-linker.js';
import {
  emptyFactsIssue,
  validateMoveIngestOutput,
  type EmptyFactsPackage,
  type MoveConsistencyIssue,
} from './consistency.js';
import { createMoveEntryPointEdges } from './entry-points.js';

// ── Phase output ───────────────────────────────────────────────────────────

export interface MoveIngestOutput extends StandaloneIngestOutput {
  /** Move package roots (absolute directories containing Move.toml). */
  packageRoots: string[];
  /** Module qualified names → source file path (repo-relative or package-root). */
  moduleFileMap: ReadonlyMap<string, string>;
  /** Function qualified names → graph node IDs. */
  functionNodeMap: ReadonlyMap<string, string>;
  /** Struct/enum qualified names → graph node IDs. */
  structNodeMap: ReadonlyMap<string, string>;
  /** Module qualified names → absolute package root. */
  modulePackageMap: ReadonlyMap<string, string>;
  /** Repo-relative file paths → absolute package root. */
  filePackageMap: ReadonlyMap<string, string>;
  /** Absolute package root → compiler call graph for that package. */
  callGraphByPackage: ReadonlyMap<string, CallGraphMap>;
  /** Resource references dropped during global resolution. */
  droppedResourceRefs: { fnNodeId: string; target: string }[];
  /** Signature/type references dropped during global resolution. */
  droppedTypeRefs: { sourceNodeId: string; target: string }[];
  /** Friend declarations whose target module never got a Module node. */
  droppedFriends: { moduleNodeId: string; friend: string }[];
  /** Lambda functions whose host function never got a Function node. */
  droppedLambdaHosts: { lambdaFnNodeId: string; hostQualified: string }[];
  /** Supplemental function-usage queries that could not be completed. */
  functionUsageFailures: FunctionUsageFailure[];
  /** Non-fatal consistency issues found after Move ingestion. */
  consistencyIssues: MoveConsistencyIssue[];
}

/** Mutable accumulator shared while ingesting every package. */
interface MoveIngestState extends MoveLinkState {
  ingestedFiles: Set<string>;
  modulePackageMap: Map<string, string>;
  filePackageMap: Map<string, string>;
  functionUsageFailures: FunctionUsageFailure[];
}

function createState(): MoveIngestState {
  return {
    ingestedFiles: new Set(),
    moduleFileMap: new Map(),
    functionNodeMap: new Map(),
    structNodeMap: new Map(),
    modulePackageMap: new Map(),
    filePackageMap: new Map(),
    callGraphByPackage: new Map(),
    closureCallsByPackage: new Map(),
    pendingResource: [],
    pendingFriends: [],
    pendingTypeRef: [],
    pendingLambdaHosts: [],
    droppedResourceRefs: [],
    droppedTypeRefs: [],
    droppedFriends: [],
    droppedLambdaHosts: [],
    functionUsageFailures: [],
  };
}

function toOutput(
  state: MoveIngestState,
  packageRoots: string[],
  consistencyIssues: MoveConsistencyIssue[] = [],
): MoveIngestOutput {
  return {
    ingestedFiles: state.ingestedFiles,
    packageRoots,
    moduleFileMap: state.moduleFileMap,
    functionNodeMap: state.functionNodeMap,
    structNodeMap: state.structNodeMap,
    modulePackageMap: state.modulePackageMap,
    filePackageMap: state.filePackageMap,
    callGraphByPackage: state.callGraphByPackage,
    droppedResourceRefs: state.droppedResourceRefs,
    droppedTypeRefs: state.droppedTypeRefs,
    droppedFriends: state.droppedFriends,
    droppedLambdaHosts: state.droppedLambdaHosts,
    functionUsageFailures: state.functionUsageFailures,
    consistencyIssues,
  };
}

/** Add a mapped package's nodes/edges to the graph and merge its identity maps. */
function applyMapped(
  graph: KnowledgeGraph,
  mapped: MoveFactsMapResult,
  pkgRoot: string,
  state: MoveIngestState,
): void {
  for (const node of mapped.nodes) graph.addNode(node);
  for (const rel of mapped.edges) graph.addRelationship(rel);
  for (const [qn, file] of mapped.moduleFileMap) {
    state.moduleFileMap.set(qn, file);
    state.modulePackageMap.set(qn, pkgRoot);
    state.filePackageMap.set(file, pkgRoot);
  }
  for (const [qn, id] of mapped.functionNodeMap) state.functionNodeMap.set(qn, id);
  for (const [qn, id] of mapped.structNodeMap) state.structNodeMap.set(qn, id);
  state.pendingResource.push(...mapped.pendingResource);
  state.pendingFriends.push(...mapped.pendingFriends);
  state.pendingTypeRef.push(...mapped.pendingTypeRef);
  state.pendingLambdaHosts.push(...mapped.pendingLambdaHosts);
}

export function createMoveIngestPhase(
  client: MoveFlowClient | null,
): PipelinePhase<MoveIngestOutput> {
  return {
    name: 'standaloneIngest',
    deps: ['structure'],

    async execute(
      ctx: PipelineContext,
      deps: ReadonlyMap<string, PhaseResult<unknown>>,
    ): Promise<MoveIngestOutput> {
      const { scannedFiles, totalFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');

      const packageRoots = [
        ...new Set(
          scannedFiles
            .map((f) => f.path)
            .filter((p) => p.endsWith('Move.toml'))
            .map((p) => path.dirname(path.resolve(ctx.repoPath, p))),
        ),
      ].sort();
      if (!client || packageRoots.length === 0) {
        return toOutput(createState(), packageRoots);
      }

      const { hasFactsQuery, hasFunctionUsageQuery, hasStatusTool } = await client.capabilities();
      if (!hasFactsQuery) {
        // userActionable: rendered as a one-liner without a stack — the fix is
        // an operator action (upgrade move-flow), not a code bug.
        throw Object.assign(
          new Error(
            'move-flow is too old — upgrade to a build that exposes `move_package_query { query: "facts" }`.',
          ),
          { userActionable: true },
        );
      }
      const state = createState();
      let functionUsageEnabled = hasFunctionUsageQuery;

      // Group scanned .move files by their (innermost) owning package. Files
      // are marked as ingested per package only AFTER its facts arrive, so a
      // package whose facts come back empty is left un-ingested rather than
      // silently absent from the graph (the generic parse phase still sees it).
      const moveFilesByPackage = new Map<string, string[]>();
      for (const f of scannedFiles) {
        if (!f.path.endsWith('.move')) continue;
        const abs = path.resolve(ctx.repoPath, f.path);
        // Boundary-safe: bare startsWith would let a sibling directory sharing
        // a name prefix (pkg_ab vs root pkg_a) claim the file.
        const owners = packageRoots.filter((root) => {
          const prefix = root.endsWith(path.sep) ? root : root + path.sep;
          return abs.startsWith(prefix);
        });
        if (owners.length === 0) continue;
        const owner = owners.reduce((a, b) => (b.length > a.length ? b : a));
        const files = moveFilesByPackage.get(owner) ?? [];
        files.push(moveRepoRelativePath(abs, ctx.repoPath));
        moveFilesByPackage.set(owner, files);
      }

      // Pass 1: per-package nodes/edges (all packages first, so cross-package
      // CALLS in Pass 2 can resolve callees in later packages).
      const emptyFactsPackages: EmptyFactsPackage[] = [];
      for (const pkgRoot of packageRoots) {
        ctx.onProgress({
          phase: 'moveIngest',
          percent: 18,
          message: `Ingesting Move package: ${path.basename(pkgRoot)}`,
          stats: { filesProcessed: 0, totalFiles, nodesCreated: ctx.graph.nodeCount },
        });

        let callGraphData: CallGraphMap;
        let factsMap: MoveFactsMap;
        try {
          callGraphData = await client.callGraph(pkgRoot);
          factsMap = await client.facts(pkgRoot);
        } catch (err) {
          throw toPackageQueryError(err, pkgRoot);
        }

        const pkgMoveFiles = moveFilesByPackage.get(pkgRoot) ?? [];
        if (Object.keys(factsMap).length === 0 && pkgMoveFiles.length > 0) {
          // Facts `{}` is ambiguous: syntax-broken packages return it as a
          // SUCCESS (the compiler diagnostic only surfaces via
          // `move_package_status`), but so do valid packages whose every item
          // is `#[test]`/`#[test_only]` (elided from facts - see file header).
          // Cross-check the build status to tell them apart; either way skip
          // the package (its files stay un-ingested) and record an issue.
          emptyFactsPackages.push({
            pkgRoot,
            moveFileCount: pkgMoveFiles.length,
            status: await probePackageStatus(client, pkgRoot, hasStatusTool),
          });
          continue;
        }
        // Only past the gate: a skipped package must have zero footprint in
        // Pass 2 linking and consistency validation.
        state.callGraphByPackage.set(pkgRoot, callGraphData);
        if (functionUsageEnabled) {
          const closureCapture = await collectClosureCaptureCalls(
            client,
            pkgRoot,
            factsMap,
            callGraphData,
          );
          state.closureCallsByPackage.set(pkgRoot, closureCapture.calls);
          state.functionUsageFailures.push(...closureCapture.failures);
          if (closureCapture.failures.length > 0) functionUsageEnabled = false;
        }
        for (const rel of pkgMoveFiles) state.ingestedFiles.add(rel);
        applyMapped(ctx.graph, mapFactsToGraph(factsMap, pkgRoot, ctx.repoPath), pkgRoot, state);
      }

      // Pass 2+: link edges that need the full cross-package node index.
      linkMoveIngestGraph(ctx.graph, state);

      const output = toOutput(state, packageRoots);
      createMoveEntryPointEdges(ctx.graph, output);

      const consistencyIssues: MoveConsistencyIssue[] = emptyFactsPackages.map(emptyFactsIssue);
      consistencyIssues.push(...validateMoveIngestOutput(ctx.graph, output));
      reportConsistencyIssues(ctx, consistencyIssues);
      return { ...output, consistencyIssues };
    },
  };
}

/**
 * Map a package-query failure to its user-facing form. Build/input errors and
 * timeouts are operator problems rendered as one-liners; transport faults
 * have already used up the client's single retry, so anything else propagates
 * as the crash it is.
 */
function toPackageQueryError(err: unknown, pkgRoot: string): Error {
  if (err instanceof MoveFlowToolCallError) {
    // userActionable: rendered as a one-liner without a stack - a Move
    // package that does not build (bad manifest, missing dependency,
    // nonexistent path) is an operator problem, not a code bug.
    return Object.assign(
      new Error(`move-flow could not build Move package ${pkgRoot}: ${err.message}`),
      { userActionable: true },
    );
  }
  if (err instanceof MoveFlowTimeoutError) {
    // Fresh copy: the client owns this instance (it is reused across the
    // transport retry), so stamping the original would mutate state we do
    // not own. The message already names the fix (raise
    // GITNEXUS_MOVE_FLOW_TIMEOUT_MS).
    return Object.assign(new Error(err.message), { userActionable: true });
  }
  return err instanceof Error ? err : new Error(String(err));
}

// --- Empty-facts discrimination ---

/** Cross-check the build status of a sources-but-empty-facts package.
 *  `null` = status unavailable (no status tool, or the probe itself failed). */
async function probePackageStatus(
  client: MoveFlowClient,
  pkgRoot: string,
  hasStatusTool: boolean,
): Promise<MovePackageStatus | null> {
  if (!hasStatusTool) return null;
  try {
    return await client.packageStatus(pkgRoot);
  } catch {
    // Probe failure -> cannot discriminate; fall back to the pessimistic issue.
    return null;
  }
}

/** Surface consistency errors so they reach a human/log (not just the output). */
function reportConsistencyIssues(ctx: PipelineContext, issues: MoveConsistencyIssue[]): void {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length === 0) return;
  ctx.onProgress({
    phase: 'moveIngest',
    percent: 22,
    message: `Move ingest: ${errors.length} consistency error(s) (e.g. ${errors[0].message})`,
    stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: ctx.graph.nodeCount },
  });
}
