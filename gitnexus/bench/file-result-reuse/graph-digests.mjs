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
  // Retain fixed-size hashes, not serialized source text. Whole-graph strings
  // (including join's copies) otherwise dominate the RSS we intend to measure.
  const rowDigest = (kind, value) =>
    createHash('sha256')
      .update(kind)
      .update(JSON.stringify(canonical(value)))
      .digest('hex');
  for (const node of nodes) {
    const row = rowDigest('N ', node);
    rows.push(row);
    if (!derivedIds.has(node.id)) parsedRows.push(row);
  }
  for (const edge of graph.relationships) {
    const row = rowDigest('R ', edge);
    rows.push(row);
    edges++;
    if (!derivedIds.has(edge.sourceId) && !derivedIds.has(edge.targetId)) {
      parsedRows.push(row);
      parsedEdges++;
    }
  }
  const digest = (values) => {
    const hash = createHash('sha256');
    for (const value of values.sort()) hash.update(value);
    return hash.digest('hex');
  };
  return {
    nodes: nodes.length,
    edges,
    digest: digest(rows),
    parsedNodes: nodes.length - derivedIds.size,
    parsedEdges,
    parsedDigest: digest(parsedRows),
  };
}
