// gitnexus/src/core/coverage/line-mapper.ts
import type { KnowledgeGraph } from '../graph/types.js';
import type { LineNodeMapping } from './types.js';

/**
 * Maps file:line coverage hits to KnowledgeGraph nodes.
 * Algorithm: for each line hit, find all nodes whose startLine ≤ line ≤ endLine.
 * Return the most specific (tightest range) match per line.
 */
export function mapLinesToNodes(
  lineHits: Map<string, Map<number, number>>,
  graph: KnowledgeGraph,
): LineNodeMapping[] {
  const nodesByFile = new Map<string, (typeof graph.nodes)[number][]>();
  for (const node of graph.nodes) {
    const fp = node.properties.filePath;
    if (!fp) continue;
    if (!nodesByFile.has(fp)) nodesByFile.set(fp, []);
    nodesByFile.get(fp)!.push(node);
  }

  const results: LineNodeMapping[] = [];

  for (const [filePath, lineMap] of lineHits) {
    const fileNodes = nodesByFile.get(filePath);
    if (!fileNodes) continue;

    for (const [lineStr, hitCount] of lineMap) {
      const lineNumber = lineStr;

      const matching = fileNodes.filter(
        (n) =>
          n.properties.startLine !== undefined &&
          n.properties.endLine !== undefined &&
          n.properties.startLine <= lineNumber &&
          lineNumber <= n.properties.endLine,
      );

      if (matching.length === 0) continue;

      matching.sort(
        (a, b) =>
          ((a.properties.endLine ?? 0) - (a.properties.startLine ?? 0)) -
          ((b.properties.endLine ?? 0) - (b.properties.startLine ?? 0)),
      );

      results.push({
        lineNumber,
        filePath,
        hitCount,
        matchedNodes: matching.map((n) => n.id),
      });
    }
  }

  return results;
}

/**
 * Aggregate line-node mappings into per-symbol coverage ratios.
 * Returns Map<nodeId, { totalLines, coveredLines, ratio }>
 */
export function aggregateSymbolCoverage(
  mappings: LineNodeMapping[],
): Map<string, { totalLines: number; coveredLines: number; ratio: number }> {
  const symbolLines = new Map<string, { total: Set<number>; covered: Set<number> }>();

  for (const m of mappings) {
    const primary = m.matchedNodes[0];
    if (!primary) continue;

    if (!symbolLines.has(primary)) {
      symbolLines.set(primary, { total: new Set(), covered: new Set() });
    }
    const entry = symbolLines.get(primary)!;
    entry.total.add(m.lineNumber);
    if (m.hitCount > 0) entry.covered.add(m.lineNumber);
  }

  const result = new Map<string, { totalLines: number; coveredLines: number; ratio: number }>();
  for (const [nodeId, data] of symbolLines) {
    const totalLines = data.total.size;
    const coveredLines = data.covered.size;
    result.set(nodeId, {
      totalLines,
      coveredLines,
      ratio: totalLines > 0 ? coveredLines / totalLines : 0,
    });
  }

  return result;
}
