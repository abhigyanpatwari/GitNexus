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

function siteTargetKey({ file, start, end }, target) {
  return JSON.stringify([file, start, end, target]);
}

export function gitNexusCallReport(
  result,
  { names, ambiguousReasons = [], excludeEdgeReasons = [], typeCaller },
) {
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
  const unpublishedOverloads = new Set();
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
        // Overloads can have distinct definition positions but share one legacy graph node.
        // Preserve the resolver's actual selection; the edge comparison verifies publication.
        const id = outcome.targetId;
        const suffix = ':Method:' + outcome.name;
        const position =
          id.startsWith('def:') && id.endsWith(suffix) ? id.slice(4, -suffix.length) : undefined;
        const published = declarations.get(id);
        if (published === undefined && position && /#\d+:\d+$/.test(position)) {
          record.target = position;
          const file = position.slice(0, position.lastIndexOf('#'));
          unpublishedOverloads.add(siteTargetKey(site, [file, outcome.name]));
        } else {
          record.target = published ?? id;
          classifiedTargets.add(siteTargetKey(site, record.target));
        }
      }
      sites.push(record);
    }
  }

  const edges = [];
  for (const edge of result.graph.iterRelationshipsByType('CALLS')) {
    if (excludeEdgeReasons.includes(edge.reason)) continue;
    const target = result.graph.getNode(edge.targetId);
    if (!target || !selected.has(target.properties.name)) continue;
    const caller = result.graph.getNode(edge.sourceId);
    const to = graphDeclaration(target);
    edges.push({ from: typeCaller?.(caller) ?? graphDeclaration(caller), to });
    const site = edgeSite(edge, caller.properties.filePath, to);
    if (!site || classifiedTargets.has(siteTargetKey(site, to))) continue;
    // A shared method node can verify publication but cannot locate a second overload.
    const method = [target.properties.filePath, target.properties.name];
    if (target.label !== 'Method' || !unpublishedOverloads.has(siteTargetKey(site, method))) {
      sites.push(site);
    }
  }
  return { producer: 'GitNexus', sites, edges };
}
