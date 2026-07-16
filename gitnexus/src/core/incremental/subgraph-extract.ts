/**
 * Subgraph extraction for incremental DB writeback.
 *
 * Given the FULL ctx.graph produced by the pipeline (all files parsed,
 * all phases run) and the set of file paths whose DB rows must be
 * replaced, produce a smaller KnowledgeGraph that contains:
 *
 *   - Every node whose `properties.filePath` is in `toWriteSet`.
 *   - Every graph-wide node (Community, Process) — these are regenerated
 *     each run by the communities/processes phases and must be fully
 *     rewritten.
 *   - Every relationship where AT LEAST ONE endpoint is in the writable
 *     set above. Relationships entirely between unchanged-file nodes
 *     are skipped — their rows are still in the DB and re-inserting
 *     them would PK-conflict at COPY time.
 *
 * The resulting subgraph is what gets passed to `loadGraphToLbug` after
 * the orchestrator has deleted the corresponding DB rows. Hydrated
 * unchanged-file rows are never touched in the DB.
 *
 * # Cross-file edge consistency (Finding 1)
 *
 * `extractChangedSubgraph` intentionally does NOT expand the set it is
 * given — expansion is the orchestrator's job, so the SAME expanded set
 * can be fed to both `deleteNodesForFiles` and this function (asymmetry
 * between the delete set and the write set silently corrupts the DB).
 * `computeEffectiveWriteSet` below performs the boundary-crossing 1-hop
 * walk; the orchestrator composes it with its importer-BFS expansion and
 * passes the result here.
 *
 * Why the 1-hop walk is needed: consider a barrel re-export change —
 * file C (a barrel) shifts `export { foo } from './b'` to
 * `export { foo } from './d'`. After scope resolution, file A's CALLS
 * edge to `foo` resolves to D instead of B, even though A's content is
 * byte-for-byte identical:
 *
 *   - Old A→B edge survives in DB (neither A nor B is changed → not deleted)
 *   - New A→D edge is missing (neither A nor D in writable set → skipped)
 *
 * Pulling the unchanged-side file of every writable-boundary-crossing
 * edge into the write set fixes both halves: the orchestrator's
 * `DETACH DELETE` cleans up the stale unchanged-side rows, and the new
 * cross-file edges land because at least one endpoint is now writable.
 *
 * Limitation (documented): if a file X *stopped* importing from a
 * changed file C, X has no edge to C in the new graph, so this 1-hop
 * walk doesn't catch it. The orchestrator's importer-BFS (which reads
 * IMPORTS from the pre-pipeline DB) covers that case instead.
 */

import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../graph/graph.js';
import type { KnowledgeGraph } from '../graph/types.js';

const isGraphWide = (label: string): boolean => label === 'Community' || label === 'Process';

/**
 * Relationship types whose VALIDITY is a whole-program property, not a
 * function of their endpoints' files (#2084 M4 U6). `TAINT_PATH` (cross-
 * function taint) can be invalidated by a change to an INTERMEDIATE function
 * on a third file, so the endpoint-writability rule below would skip a stale
 * A→C edge. These are always extracted (and the orchestrator delete-alls them
 * first, like Community/Process) so they rebuild from the fresh graph.
 */
// `CALL_SUMMARY` (PDG FU-C) is intra-procedural (a callee's RETURN-VALUE ASCENT
// depends only on its OWN body), but the orchestrator delete-alls it on an
// incremental `--pdg` writeback to keep the emit path single — so it must be
// re-included from the FULL fresh graph (which the emit phase recomputes every
// run) or an unchanged function's summary would be lost. Cheap: one self-loop
// edge per return-flowing function.
//
// `INJECTS` (DI collection injection, #2200) is the same class as TAINT_PATH
// (the #2084 M4 U6 pattern above): its validity is a whole-program property —
// a change to a THIRD file (the interface itself, or a new/removed
// implementer) creates or invalidates edges between two files that were never
// touched, so the endpoint-writability rule would strand a stale
// consumer→implementer edge (or miss a new one). Always re-extracted from the
// fresh graph; the orchestrator unconditionally delete-alls the old rows
// first (`deleteAllInjects`). Crash-recovery: delete-then-COPY is not atomic
// by design — a crash between them loses INJECTS edges until the next
// analyze, and the `incrementalInProgress` dirty flag (saved before any
// delete) forces a full rebuild on the next run. Temporary absence is
// possible; duplicates are not.
const isGraphWideRelType = (type: string): boolean =>
  type === 'TAINT_PATH' || type === 'CALL_SUMMARY' || type === 'INJECTS';

/**
 * Build a Map<nodeId, filePath> for every File-bound node in the graph.
 * Graph-wide nodes (Community/Process) have no filePath and are filtered.
 */
const indexNodeFilePaths = (fullGraph: KnowledgeGraph): Map<string, string> => {
  const idx = new Map<string, string>();
  fullGraph.forEachNode((n: GraphNode) => {
    const fp = n.properties?.filePath as string | undefined;
    if (fp) idx.set(n.id, fp);
  });
  return idx;
};

export const extractChangedSubgraph = (
  fullGraph: KnowledgeGraph,
  toWriteSet: ReadonlySet<string>,
): KnowledgeGraph => {
  const sub = createKnowledgeGraph();
  const writableNodeIds = new Set<string>();

  fullGraph.forEachNode((n: GraphNode) => {
    const filePath = n.properties?.filePath as string | undefined;
    const include = (filePath && toWriteSet.has(filePath)) || isGraphWide(n.label);
    if (include) {
      sub.addNode(n);
      writableNodeIds.add(n.id);
    }
  });

  fullGraph.forEachRelationship((r: GraphRelationship) => {
    if (
      writableNodeIds.has(r.sourceId) ||
      writableNodeIds.has(r.targetId) ||
      isGraphWideRelType(r.type)
    ) {
      sub.addRelationship(r);
    }
  });

  return sub;
};

/**
 * Public — derive the EFFECTIVE write-set: `toWriteSet` expanded by one
 * hop along every edge in the new graph that crosses the writable
 * boundary (one endpoint in a writable file, the other in an unchanged
 * file). The unchanged-side file is pulled in so its stale rows are
 * deleted + rewritten in lockstep with the changed side.
 *
 * Single pass over the edge list. Does NOT mutate `toWriteSet`. The
 * orchestrator MUST feed the returned set to both `deleteNodesForFiles`
 * and `extractChangedSubgraph` — feeding the unexpanded set to either
 * one leaves stale rows or PK-conflicts at COPY time.
 */
export const computeEffectiveWriteSet = (
  fullGraph: KnowledgeGraph,
  toWriteSet: ReadonlySet<string>,
): Set<string> => {
  const nodeFilePaths = indexNodeFilePaths(fullGraph);
  const expanded = new Set<string>(toWriteSet);
  fullGraph.forEachRelationship((r: GraphRelationship) => {
    const sourcePath = nodeFilePaths.get(r.sourceId);
    const targetPath = nodeFilePaths.get(r.targetId);
    if (!sourcePath || !targetPath) return; // skip edges to graph-wide nodes
    const sourceWritable = toWriteSet.has(sourcePath);
    const targetWritable = toWriteSet.has(targetPath);
    if (sourceWritable && !targetWritable) expanded.add(targetPath);
    else if (targetWritable && !sourceWritable) expanded.add(sourcePath);
  });
  return expanded;
};
