import { createHash } from 'node:crypto';

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

/** Keep full-graph reuse checks, but compare parser output across runtime versions. */
export function graphDigests(graph) {
  const nodes = [...graph.nodes];
  const derivedIds = new Set(
    nodes
      .filter((node) => node.label === 'Community' || node.label === 'Process')
      .map((node) => node.id),
  );
  const rows = [],
    parsedRows = [];
  let edges = 0,
    parsedEdges = 0;
  for (const node of nodes) {
    const row = 'N ' + JSON.stringify(canonical(node));
    rows.push(row);
    if (!derivedIds.has(node.id)) parsedRows.push(row);
  }
  for (const edge of graph.relationships) {
    const row = 'R ' + JSON.stringify(canonical(edge));
    rows.push(row);
    edges++;
    if (!derivedIds.has(edge.sourceId) && !derivedIds.has(edge.targetId)) {
      parsedRows.push(row);
      parsedEdges++;
    }
  }
  const digest = (values) => createHash('sha256').update(values.sort().join('\n')).digest('hex');
  return {
    nodes: nodes.length,
    edges,
    digest: digest(rows),
    parsedNodes: nodes.length - derivedIds.size,
    parsedEdges,
    parsedDigest: digest(parsedRows),
  };
}
