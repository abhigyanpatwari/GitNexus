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
import { MOVE_EDGE_REASON, moveRepoRelativePath } from './constants.js';
import {
  MoveFlowToolCallError,
  type MoveFlowClient,
  type MovePackageStatus,
} from './mcp-client.js';
import {
  buildLocalNameIndex,
  mapFactsToGraph,
  resolveFriendEdges,
  resolveLambdaHostEdges,
  resolveResourceEdges,
  resolveTypeRefEdges,
  type MoveFactsMapResult,
  type PendingFriend,
  type PendingLambdaHost,
  type PendingResource,
  type PendingTypeRef,
} from './facts-mapper.js';
import type { CallGraphMap, MoveFactsMap } from './compiler-facts.js';
import { moveModuleNodeId, moveModuleQualifiedName, moveRelId } from './symbol-id.js';
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
  droppedResourceRefs?: { fnNodeId: string; target: string }[];
  /** Non-fatal consistency issues found after Move ingestion. */
  consistencyIssues: MoveConsistencyIssue[];
}

/** Mutable accumulator shared while ingesting every package. */
interface MoveIngestState {
  ingestedFiles: Set<string>;
  moduleFileMap: Map<string, string>;
  functionNodeMap: Map<string, string>;
  structNodeMap: Map<string, string>;
  modulePackageMap: Map<string, string>;
  filePackageMap: Map<string, string>;
  callGraphByPackage: Map<string, CallGraphMap>;
  pendingResource: PendingResource[];
  pendingFriends: PendingFriend[];
  pendingTypeRef: PendingTypeRef[];
  pendingLambdaHosts: PendingLambdaHost[];
  droppedResourceRefs: { fnNodeId: string; target: string }[];
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
    pendingResource: [],
    pendingFriends: [],
    pendingTypeRef: [],
    pendingLambdaHosts: [],
    droppedResourceRefs: [],
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

      const { hasFactsQuery, hasStatusTool } = await client.capabilities();
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

      const emptyFactsPackages: EmptyFactsPackage[] = [];

      // Pass 1: per-package nodes/edges (all packages first, so cross-package
      // CALLS in Pass 2 can resolve callees in later packages).
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
          if (err instanceof MoveFlowToolCallError) {
            // userActionable: rendered as a one-liner without a stack - a Move
            // package that does not build (bad manifest, missing dependency,
            // nonexistent path) is an operator problem, not a code bug.
            throw Object.assign(
              new Error(`move-flow could not build Move package ${pkgRoot}: ${err.message}`),
              { userActionable: true },
            );
          }
          throw err;
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
        for (const rel of pkgMoveFiles) state.ingestedFiles.add(rel);

        applyMapped(ctx.graph, mapFactsToGraph(factsMap, pkgRoot, ctx.repoPath), pkgRoot, state);
      }

      // Pass 2+: link edges that need the full cross-package node index.
      linkCallEdges(ctx.graph, state);
      linkLambdaHostEdges(ctx.graph, state);
      linkResourceAndFriendEdges(ctx.graph, state);
      linkFileImports(ctx.graph, state);
      linkFileModuleContains(ctx.graph, state);

      const output = toOutput(state, packageRoots);
      createMoveEntryPointEdges(ctx.graph, output);

      const consistencyIssues: MoveConsistencyIssue[] = emptyFactsPackages.map(emptyFactsIssue);
      consistencyIssues.push(...validateMoveIngestOutput(ctx.graph, output));
      reportConsistencyIssues(ctx, consistencyIssues);
      return { ...output, consistencyIssues };
    },
  };
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

/** CALLS edges from each package's call graph (resolved across all packages). */
function linkCallEdges(graph: KnowledgeGraph, state: MoveIngestState): void {
  for (const callGraph of state.callGraphByPackage.values()) {
    for (const [callerQualified, callees] of Object.entries(callGraph)) {
      const callerId = state.functionNodeMap.get(callerQualified);
      if (!callerId) continue;
      for (const calleeQualified of callees) {
        const calleeId = state.functionNodeMap.get(calleeQualified);
        if (!calleeId) continue;
        graph.addRelationship({
          id: moveRelId(callerId, 'CALLS', calleeId, MOVE_EDGE_REASON.calls),
          sourceId: callerId,
          targetId: calleeId,
          type: 'CALLS',
          confidence: 1.0,
          reason: MOVE_EDGE_REASON.calls,
        });
      }
    }
  }
}

/**
 * CALLS edges from each `__lambda__N__host` function back to its host. move-flow
 * synthesises lambdas as standalone functions but does NOT include the host-to-
 * lambda link in `call_graph` — without it, upstream traversal from the lambda
 * dead-ends and processes that route through a callback (e.g. market_callbacks
 * → settle_trade) lose the bridge.
 */
function linkLambdaHostEdges(graph: KnowledgeGraph, state: MoveIngestState): void {
  resolveLambdaHostEdges(state.pendingLambdaHosts, state.functionNodeMap, (rel) =>
    graph.addRelationship(rel),
  );
}

/** Resource/friend edges from facts, resolved after all package nodes exist. */
function linkResourceAndFriendEdges(graph: KnowledgeGraph, state: MoveIngestState): void {
  const structIdsByLocalName = buildLocalNameIndex(state.structNodeMap);
  resolveResourceEdges(
    state.pendingResource,
    state.structNodeMap,
    structIdsByLocalName,
    (rel) => graph.addRelationship(rel),
    (pending) =>
      state.droppedResourceRefs.push({ fnNodeId: pending.fnNodeId, target: pending.target }),
    (pending) =>
      state.droppedResourceRefs.push({ fnNodeId: pending.fnNodeId, target: pending.target }),
  );
  resolveFriendEdges(state.pendingFriends, state.moduleFileMap, (rel) =>
    graph.addRelationship(rel),
  );
  resolveTypeRefEdges(state.pendingTypeRef, state.structNodeMap, structIdsByLocalName, (rel) => {
    graph.addRelationship(rel);
    addUsedType(graph, rel.sourceId, rel.targetId);
  });
}

function addUsedType(graph: KnowledgeGraph, functionNodeId: string, typeNodeId: string): void {
  const fnNode = graph.getNode(functionNodeId);
  const typeNode = graph.getNode(typeNodeId);
  const qualifiedName = typeNode?.properties.qualifiedName;
  // Only Function nodes carry `usedTypes` - resource-group membership USES_TYPE
  // edges have a Struct source and must not grow the property there.
  if (!fnNode || fnNode.label !== 'Function' || typeof qualifiedName !== 'string') return;

  const current = Array.isArray(fnNode.properties.usedTypes) ? fnNode.properties.usedTypes : [];
  if (current.includes(qualifiedName)) return;
  fnNode.properties.usedTypes = [...current, qualifiedName];
}

/** File→File IMPORTS derived from cross-module CALLS (deduped against existing). */
function linkFileImports(graph: KnowledgeGraph, state: MoveIngestState): void {
  const seen = new Set<string>();
  for (const r of graph.iterRelationshipsByType('IMPORTS')) {
    if (!r.sourceId.startsWith('File:') || !r.targetId.startsWith('File:')) continue;
    seen.add(`${r.sourceId.slice(5)}\0${r.targetId.slice(5)}`);
  }
  for (const callGraph of state.callGraphByPackage.values()) {
    for (const [callerQualified, callees] of Object.entries(callGraph)) {
      const callerFile = state.moduleFileMap.get(moveModuleQualifiedName(callerQualified));
      if (!callerFile) continue;
      for (const calleeQualified of callees) {
        const calleeFile = state.moduleFileMap.get(moveModuleQualifiedName(calleeQualified));
        if (!calleeFile || calleeFile === callerFile) continue;
        const key = `${callerFile}\0${calleeFile}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sourceFileId = `File:${callerFile}`;
        const targetFileId = `File:${calleeFile}`;
        if (graph.getNode(sourceFileId) && graph.getNode(targetFileId)) {
          graph.addRelationship({
            id: moveRelId(
              sourceFileId,
              'IMPORTS',
              targetFileId,
              MOVE_EDGE_REASON.crossModuleDependency,
            ),
            sourceId: sourceFileId,
            targetId: targetFileId,
            type: 'IMPORTS',
            confidence: 0.9,
            reason: MOVE_EDGE_REASON.crossModuleDependency,
          });
        }
      }
    }
  }
}

/** File→Module CONTAINS where the File node exists (from the structure phase). */
function linkFileModuleContains(graph: KnowledgeGraph, state: MoveIngestState): void {
  for (const [qn, file] of state.moduleFileMap) {
    const fileNodeId = `File:${file}`;
    const moduleNodeId = moveModuleNodeId(qn, file);
    if (graph.getNode(fileNodeId) && graph.getNode(moduleNodeId)) {
      graph.addRelationship({
        id: moveRelId(fileNodeId, 'CONTAINS', moduleNodeId, MOVE_EDGE_REASON.moduleInFile),
        sourceId: fileNodeId,
        targetId: moduleNodeId,
        type: 'CONTAINS',
        confidence: 1.0,
        reason: MOVE_EDGE_REASON.moduleInFile,
      });
    }
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
