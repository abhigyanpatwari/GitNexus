/**
 * Source-Sink Structural Scanner
 *
 * BFS over the existing CALLS graph to find paths from source-adjacent
 * functions to sink-adjacent functions. No CFG, no taint tracking —
 * pure structural reachability.
 *
 * This is Phase A of the security analysis path described in the
 * architecture assessment. Detects OWASP A03, A07, A10 via structural
 * reachability.
 */

export interface SourceNode {
  id: string;
  name: string;
  filePath: string;
  sourcePatterns: string[];
}

export interface SinkNode {
  id: string;
  name: string;
  filePath: string;
  sinkPatterns: string[];
  owasp: string;
}

export interface SourceSinkPath {
  source: SourceNode;
  sink: SinkNode;
  /** Ordered node IDs from source to sink */
  path: string[];
  /** Number of hops from source to sink */
  depth: number;
  /** OWASP category from the sink */
  owasp: string;
  /** Risk level based on depth and sink severity */
  risk: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Find all reachable paths from source-adjacent nodes to sink-adjacent nodes
 * using BFS over the CALLS graph.
 *
 * @param sources - Functions identified as source-adjacent (read user input)
 * @param sinks - Functions identified as sink-adjacent (perform dangerous ops)
 * @param callsGraph - Forward adjacency map: nodeId -> [calleeIds]
 * @param maxDepth - Maximum BFS depth (default: 5)
 * @returns All source-to-sink paths found
 */
export function buildSourceSinkPaths(
  sources: SourceNode[],
  sinks: SinkNode[],
  callsGraph: Map<string, string[]>,
  maxDepth: number = 5,
): SourceSinkPath[] {
  const sinkMap = new Map(sinks.map(s => [s.id, s]));
  const results: SourceSinkPath[] = [];

  for (const source of sources) {
    // BFS from this source
    const visited = new Set<string>();
    // Queue: [currentNodeId, path so far]
    const queue: Array<[string, string[]]> = [[source.id, [source.id]]];
    visited.add(source.id);

    while (queue.length > 0) {
      const [currentId, currentPath] = queue.shift()!;
      const depth = currentPath.length - 1;

      if (depth >= maxDepth) continue;

      const callees = callsGraph.get(currentId) || [];
      for (const calleeId of callees) {
        if (visited.has(calleeId)) continue;
        visited.add(calleeId);

        const newPath = [...currentPath, calleeId];

        // Check if this callee is a sink
        const sink = sinkMap.get(calleeId);
        if (sink) {
          results.push({
            source,
            sink,
            path: newPath,
            depth: newPath.length - 1,
            owasp: sink.owasp,
            risk: computeRisk(newPath.length - 1, sink.owasp),
          });
          // Don't stop — there may be other sinks reachable
        }

        // Continue BFS
        queue.push([calleeId, newPath]);
      }
    }
  }

  // Sort by risk (critical first), then by depth (shortest first)
  const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  results.sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || a.depth - b.depth);

  return results;
}

function computeRisk(depth: number, owasp: string): 'critical' | 'high' | 'medium' | 'low' {
  // Direct call to dangerous sink = critical
  if (depth <= 1 && (owasp === 'A03-injection' || owasp === 'A07-xss')) return 'critical';
  // Short path to dangerous sink = high
  if (depth <= 2) return 'high';
  // Longer paths = medium (may have sanitizers in between)
  if (depth <= 4) return 'medium';
  // Very long paths are low confidence
  return 'low';
}
