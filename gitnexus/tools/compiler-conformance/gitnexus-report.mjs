import assert from 'node:assert/strict';

// Scope resolution uses definition IDs. CALLS uses graph node IDs. Join both
// to source locations so the compiler needs no knowledge of either ID format.
function graphDeclaration(node) {
  const { filePath, startLine, startColumn } = node.properties;
  if (node.label === 'File' && filePath) return filePath;
  assert.ok(
    filePath && Number.isInteger(startLine) && Number.isInteger(startColumn),
    `Missing declaration position for ${node.id}`,
  );
  return `${filePath}#${startLine + 1}:${startColumn}`;
}

// Only a complete edge span identifies a call. Point-only and aggregated
// edges still contribute their caller/target pair to the graph comparison.
function edgeSite(edge, file, target) {
  const prefix = `rel:CALLS:${edge.sourceId}->${edge.targetId}:`;
  if (!edge.id.startsWith(prefix)) return;
  const span = /^(\d+:\d+):(\d+:\d+)$/.exec(edge.id.slice(prefix.length));
  if (!span || span[1] === span[2]) return;
  return { file, start: span[1], end: span[2], status: 'resolved', target };
}

function siteTargetKey({ file, start, end, target }) {
  return JSON.stringify([file, start, end, target]);
}

export function gitNexusCallReport(result, { names, ambiguousReasons = [] }) {
  const selected = new Set(names);
  const declarations = new Map();
  for (const node of result.graph.nodes) {
    const { name, startLine, startColumn } = node.properties;
    if (!selected.has(name) || startLine == null || startColumn == null) continue;
    const location = graphDeclaration(node);
    declarations.set(node.id, location);
    declarations.set(`def:${location}:${node.label}:${name}`, location);
  }

  const sites = [];
  const classifiedTargets = new Set();
  for (const outcome of result.resolutionOutcomes) {
    if (!selected.has(outcome.name) || !outcome.range) continue;
    if (outcome.siteKind && outcome.siteKind !== 'call') continue;
    const { startLine, startCol, endLine, endCol } = outcome.range;
    const site = {
      file: outcome.filePath,
      start: `${startLine}:${startCol}`,
      end: `${endLine}:${endCol}`,
    };
    if (outcome.kind === 'suppressed') {
      const status = ambiguousReasons.includes(outcome.reason) ? 'ambiguous' : outcome.reason;
      sites.push({ ...site, status });
    } else {
      const record = { ...site, status: outcome.kind };
      if (outcome.targetId !== undefined) {
        record.target = declarations.get(outcome.targetId) ?? outcome.targetId;
        classifiedTargets.add(siteTargetKey(record));
      }
      sites.push(record);
    }
  }

  const edges = [];
  for (const edge of result.graph.iterRelationshipsByType('CALLS')) {
    const target = result.graph.getNode(edge.targetId);
    if (!target || !selected.has(target.properties.name)) continue;
    const caller = result.graph.getNode(edge.sourceId);
    const to = graphDeclaration(target);
    edges.push({ from: graphDeclaration(caller), to });
    const site = edgeSite(edge, caller.properties.filePath, to);
    if (site && !classifiedTargets.has(siteTargetKey(site))) sites.push(site);
  }
  return { producer: 'GitNexus', sites, edges };
}
