import fs from 'node:fs';
import path from 'node:path';
import { compareCodeUnits } from '../../tools/compiler-conformance/compare.mjs';
import type { GraphRelationship } from 'gitnexus-shared';
import type { PipelineResult } from '../../src/types/pipeline.js';

/**
 * Materialize an in-memory fixture repo under `root`, creating parent
 * directories as needed.
 *
 * Writes in `Object.entries` order, i.e. the literal's own key order — some
 * callers depend on that (a fixture whose second file must be written after
 * the first for the property under test to mean anything), so this must stay
 * insertion-ordered rather than sorting or parallelizing the writes.
 */
export function writeFixtureRepo(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
}

export type RelEdge = {
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  sourceFilePath: string;
  targetFilePath: string;
  rel: GraphRelationship;
};

export function getRelationships(result: PipelineResult, type: string): RelEdge[] {
  const edges: RelEdge[] = [];
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type === type) {
      const sourceNode = result.graph.getNode(rel.sourceId);
      const targetNode = result.graph.getNode(rel.targetId);
      edges.push({
        source: sourceNode?.properties.name ?? rel.sourceId,
        target: targetNode?.properties.name ?? rel.targetId,
        sourceLabel: sourceNode?.label ?? 'unknown',
        targetLabel: targetNode?.label ?? 'unknown',
        sourceFilePath: sourceNode?.properties.filePath ?? '',
        targetFilePath: targetNode?.properties.filePath ?? '',
        rel,
      });
    }
  }
  return edges;
}

interface DanglingEdge {
  type: string;
  sourceId: string;
  targetId: string;
  missing: 'source' | 'target' | 'both';
}

/**
 * Relationships whose source or target id does not resolve to a live graph node.
 * A non-empty result means the graph has dangling edges (an endpoint that was
 * never materialized) — e.g. a HAS_METHOD edge owned by a class node that the
 * structure phase failed to create. Pass `types` to scope the check to specific
 * relationship types (e.g. `['HAS_METHOD']`).
 */
export function findDanglingEdges(result: PipelineResult, types?: string[]): DanglingEdge[] {
  const out: DanglingEdge[] = [];
  for (const rel of result.graph.iterRelationships()) {
    if (types && !types.includes(rel.type)) continue;
    const src = result.graph.getNode(rel.sourceId);
    const tgt = result.graph.getNode(rel.targetId);
    if (src && tgt) continue;
    let missing: DanglingEdge['missing'] = 'both';
    if (src) missing = 'target';
    else if (tgt) missing = 'source';
    out.push({
      type: rel.type,
      sourceId: rel.sourceId,
      targetId: rel.targetId,
      missing,
    });
  }
  return out;
}

export function getNodesByLabel(result: PipelineResult, label: string): string[] {
  const names: string[] = [];
  result.graph.forEachNode((n) => {
    if (n.label === label) names.push(n.properties.name);
  });
  return names.sort(compareCodeUnits);
}

/** Get graph nodes by label with full properties (for parameterTypes assertions). */
export function getNodesByLabelFull(
  result: PipelineResult,
  label: string,
): Array<{ name: string; properties: Record<string, any> }> {
  const nodes: Array<{ name: string; properties: Record<string, any> }> = [];
  result.graph.forEachNode((n) => {
    if (n.label === label) nodes.push({ name: n.properties.name, properties: n.properties });
  });
  return nodes.sort((a, b) => a.name.localeCompare(b.name));
}
