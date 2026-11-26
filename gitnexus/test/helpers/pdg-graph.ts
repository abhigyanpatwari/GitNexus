import { compareCodeUnits } from '../../src/lib/utils.js';
import crypto from 'node:crypto';
import type { PipelineResult } from '../../src/types/pipeline.js';
/**
 * Deterministic, path/id-independent digest of the non-PDG graph: sorted
 * label→count and relType→count maps + a sha256 over symbolic edge triples
 * (label:name keyed, not opaque ids). Mirrors `pipeline-graph-golden`'s
 * technique so the snapshot is stable across id-format refactors and only
 * trips on a real semantic change to the C-family graph.
 */
export function graphDigest(result: PipelineResult): {
  symbols: number;
  relationships: number;
  byType: Record<string, number>;
  byRelType: Record<string, number>;
  edgeDigest: string;
} {
  const byType: Record<string, number> = {};
  const byRelType: Record<string, number> = {};
  const nodeKey = new Map<string, string>();
  result.graph.forEachNode((n) => {
    byType[n.label] = (byType[n.label] ?? 0) + 1;
    const props = n.properties as Record<string, unknown>;
    const fp = (props.filePath as string | undefined) ?? '';
    const nm = (props.name as string | undefined) ?? '';
    nodeKey.set(n.id, `${n.label}:${nm}@${fp}`);
  });
  const triples: string[] = [];
  for (const rel of result.graph.iterRelationships()) {
    byRelType[rel.type] = (byRelType[rel.type] ?? 0) + 1;
    const src = nodeKey.get(rel.sourceId) ?? `?:${rel.sourceId}`;
    const dst = nodeKey.get(rel.targetId) ?? `?:${rel.targetId}`;
    triples.push(`${rel.type}|${src}|${dst}`);
  }
  triples.sort(compareCodeUnits);
  const sortObj = (o: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of Object.keys(o).sort(compareCodeUnits)) out[k] = o[k];
    return out;
  };
  return {
    symbols: result.graph.nodeCount,
    relationships: result.graph.relationshipCount,
    byType: sortObj(byType),
    byRelType: sortObj(byRelType),
    edgeDigest: crypto.createHash('sha256').update(triples.join('\n')).digest('hex'),
  };
}

/**
 * Parse a BasicBlock node id into its function anchor (#2197 U3). emit.ts
 * templates the id as `BasicBlock:<filePath>:<fnLine>:<fnCol>:<blockIndex>`
 * (filePath may itself contain `:` on some platforms) — so the anchor is every
 * segment except the trailing block index, and the function anchor is the id
 * with its final `:<blockIndex>` segment stripped. All blocks of one function
 * share that anchor; block indices restart at 0 per function.
 */
function functionAnchorOf(blockId: string): string {
  return blockId.slice(0, blockId.lastIndexOf(':'));
}

/**
 * Whether ≥1 CDG edge is sourced inside the fixture's non-terminating-loop
 * function — the load-bearing #2197 U3 claim. Locates that function via
 * `hazardMarker` (a substring of a block `text` unique to the hazard function),
 * derives its block anchor, collects every BasicBlock id under that anchor, and
 * checks whether any CDG edge's source block is one of them. Unlike the whole-
 * fixture `cdg > 0` aggregate (satisfied by ANY branching function), this proves
 * the post-dom/CDG pass actually ran for the function whose loop traps EXIT.
 */
export function cdgSourcedInHazardFunction(result: PipelineResult, hazardMarker: string): boolean {
  // Find the hazard function's anchor from the block whose text carries the
  // marker, and (separately) every block id grouped by anchor.
  let hazardAnchor: string | undefined;
  const idsByAnchor = new Map<string, Set<string>>();
  result.graph.forEachNode((n) => {
    if (n.label !== 'BasicBlock') return;
    const anchor = functionAnchorOf(n.id);
    (idsByAnchor.get(anchor) ?? idsByAnchor.set(anchor, new Set()).get(anchor)!).add(n.id);
    const text = (n.properties as { text?: string }).text ?? '';
    if (text.includes(hazardMarker)) hazardAnchor = anchor;
  });
  if (hazardAnchor === undefined) return false; // marker not found → fail the assertion
  const hazardBlockIds = idsByAnchor.get(hazardAnchor) ?? new Set<string>();
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type === 'CDG' && hazardBlockIds.has(rel.sourceId)) return true;
  }
  return false;
}
