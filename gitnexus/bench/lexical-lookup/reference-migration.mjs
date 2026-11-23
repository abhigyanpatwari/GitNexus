import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Parser from 'tree-sitter';
import tsGrammar from 'tree-sitter-typescript';
import jsGrammar from 'tree-sitter-javascript';

// These four legacy keys collapsed independently verified nested calls in the
// benchmark corpus. Other multiplicity changes fail closed.
const COLLAPSED_CALLS = new Set([
  'rel:CALLS:Function:gitnexus/src/core/ingestion/pipeline.ts:buildPhaseList->Method:gitnexus/src/core/ingestion/pipeline-phases/registry.ts:PhaseRegistry.register#2:348:4',
  'rel:CALLS:Function:gitnexus/src/core/ingestion/pipeline.ts:buildPhaseList->Function:gitnexus/src/core/ingestion/model/field-registry.ts:createFieldRegistry.register@68:2:348:4',
  'rel:CALLS:Function:gitnexus/src/core/ingestion/pipeline.ts:buildPhaseList->Function:gitnexus/src/core/ingestion/model/method-registry.ts:createMethodRegistry.register@184:2:348:4',
  'rel:CALLS:Function:gitnexus/src/core/ingestion/languages/objective-c/import-target.ts:resolveObjectiveCImportTarget->Function:gitnexus/src/core/ingestion/languages/objective-c/import-target.ts:augmentedFilePathsFor:69:8',
]);
const REFERENCE_TYPES = new Set(['CALLS', 'ACCESSES', 'USES', 'EXTENDS', 'IMPLEMENTS', 'INHERITS']);
const sources = new Map();

function digest(rows) {
  const hash = createHash('sha256');
  for (const row of [...rows].sort()) hash.update(row).update('\n');
  return { count: rows.length, sha256: hash.digest('hex') };
}

function referenceSite(edge) {
  if (!REFERENCE_TYPES.has(edge.type) || typeof edge.id !== 'string') return;
  const prefix = `rel:${edge.type}:${edge.sourceId}->${edge.targetId}`;
  if (!edge.id.startsWith(prefix)) return;
  let tail = edge.id.slice(prefix.length);
  let access = '';
  if (edge.type === 'ACCESSES') {
    const match = /^:(read|write)(?=:)/.exec(tail);
    if (!match) return;
    access = match[0];
    tail = tail.slice(access.length);
  }
  const match = /^:(0|[1-9]\d*):(0|[1-9]\d*)(?::(0|[1-9]\d*):(0|[1-9]\d*))?$/.exec(tail);
  if (!match) return;
  const coordinates = match
    .slice(1)
    .filter((v) => v !== undefined)
    .map(Number);
  if (!coordinates.every(Number.isSafeInteger)) return;
  const [line, col, endLine, endCol] = coordinates;
  if (line < 1 || (endLine !== undefined && (endLine < line || (endLine === line && endCol < col))))
    return;
  return { pointId: `${prefix}${access}:${line}:${col}`, line, col, endLine, endCol, access };
}

function sourceInfo(root, file, currentSources) {
  assert(typeof file === 'string', 'Missing source path for migrated reference');
  const fullPath = path.resolve(root, file);
  const relative = path.relative(root, fullPath);
  assert(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  const current = currentSources.get(fullPath);
  if (current) return current;
  const text = fs.readFileSync(fullPath, 'utf8');
  const cached = sources.get(fullPath);
  if (cached?.text === text) {
    currentSources.set(fullPath, cached);
    return cached;
  }
  const result = { text, lengths: text.split('\n').map((line) => Buffer.byteLength(line)) };
  sources.set(fullPath, result);
  currentSources.set(fullPath, result);
  return result;
}

function sitesAt(source, file, line, col) {
  if (!source.sites) {
    const ext = path.extname(file);
    const language =
      ext === '.tsx'
        ? tsGrammar.tsx
        : ['.ts', '.mts', '.cts'].includes(ext)
          ? tsGrammar.typescript
          : ['.js', '.jsx', '.mjs', '.cjs'].includes(ext)
            ? jsGrammar
            : undefined;
    assert(language, `Unsupported call-site language: ${file}`);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source.text);
    const sites = new Map();
    const pending = [tree.rootNode];
    while (pending.length) {
      const node = pending.pop();
      if (
        [
          'call_expression',
          'member_expression',
          'assignment_expression',
          'augmented_assignment_expression',
          'identifier',
          'type_identifier',
          'shorthand_property_identifier',
        ].includes(node.type)
      ) {
        const start = `${node.startPosition.row + 1}:${node.startPosition.column}`;
        const ends = sites.get(start) ?? [];
        const callee = node.childForFieldName('function');
        ends.push({
          type: node.type,
          end: `${node.endPosition.row + 1}:${node.endPosition.column}`,
          property: callee?.childForFieldName('property')?.text,
        });
        sites.set(start, ends);
      }
      pending.push(...node.namedChildren);
    }
    source.sites = sites;
  }
  return source.sites.get(`${line}:${col}`) ?? [];
}

/** Strict graph comparison with a narrowly scoped point-to-span migration. */
export function assertGraphParity(before, after, repo) {
  assert.deepEqual(after.graph.nodes, before.graph.nodes, 'Semantic nodes differ');
  if (
    before.graph.edges.count === after.graph.edges.count &&
    before.graph.edges.sha256 === after.graph.edges.sha256
  )
    return {
      version: 1,
      mode: 'exact',
      baseline: before.graph,
      candidate: after.graph,
      comparison: before.graph,
    };
  const oldGraph = JSON.parse(fs.readFileSync(before.graphRowsPath, 'utf8'));
  const newGraph = JSON.parse(fs.readFileSync(after.graphRowsPath, 'utf8'));
  for (const [name, snapshot, report] of [
    ['baseline', oldGraph, before],
    ['candidate', newGraph, after],
  ]) {
    assert.deepEqual(
      digest(snapshot.nodes),
      report.graph.nodes,
      `${name} node snapshot does not match sample`,
    );
    assert.deepEqual(
      digest(snapshot.edges),
      report.graph.edges,
      `${name} edge snapshot does not match sample`,
    );
  }
  const oldEdges = oldGraph.edges.map((row) => JSON.parse(row));
  const newEdges = newGraph.edges.map((row) => JSON.parse(row));
  const oldById = new Map();
  for (const edge of oldEdges) {
    assert(!oldById.has(edge.id), `Duplicate baseline identity: ${edge.id}`);
    oldById.set(edge.id, edge);
    assert(
      referenceSite(edge)?.endLine === undefined,
      'Baseline already has full-span references; strict equality required',
    );
  }
  const nodeById = new Map(
    oldGraph.nodes.map((row) => {
      const node = JSON.parse(row);
      return [node.id, node];
    }),
  );
  const groups = new Map();
  const newIds = new Set();
  const projected = new Set();
  let migrated = 0;
  for (const edge of newEdges) {
    assert(!newIds.has(edge.id), `Duplicate candidate identity: ${edge.id}`);
    newIds.add(edge.id);
    let previous = oldById.get(edge.id);
    let site;
    if (!previous) {
      site = referenceSite(edge);
      assert(site?.endLine !== undefined, `Unknown candidate identity: ${edge.id}`);
      previous = oldById.get(site.pointId);
      assert(
        previous && referenceSite(previous)?.endLine === undefined,
        `No legacy point identity: ${edge.id}`,
      );
      migrated++;
    }
    const { id: _oldId, ...oldFields } = previous;
    const { id: _newId, ...newFields } = edge;
    assert.deepEqual(newFields, oldFields, `Relationship properties changed: ${edge.id}`);
    const oldId = previous.id;
    projected.add(JSON.stringify({ ...edge, id: oldId }));
    const group = groups.get(oldId) ?? [];
    group.push({ edge, site });
    groups.set(oldId, group);
  }
  assert(migrated > 0, 'Edge differences are not a point-to-span migration');
  assert.equal(groups.size, oldById.size, 'A baseline relationship was dropped');
  const currentSources = new Map();
  for (const [oldId, group] of groups) {
    assert(
      group.length === 1 || COLLAPSED_CALLS.has(oldId),
      `Unexpected expanded identity: ${oldId}`,
    );
    if (!group[0].site) {
      assert(!COLLAPSED_CALLS.has(oldId), `Audited nested call identity did not migrate: ${oldId}`);
      continue;
    }
    const { edge, site } = group[0];
    const file = nodeById.get(edge.sourceId)?.properties?.filePath;
    const source = sourceInfo(repo, file, currentSources);
    for (const item of group) {
      assert(item.site, `Mixed point and span identities: ${oldId}`);
      const { line, col, endLine, endCol } = item.site;
      assert(
        endLine <= source.lengths.length &&
          col <= (source.lengths[line - 1] ?? -1) &&
          endCol <= source.lengths[endLine - 1],
        `Invalid source bounds: ${item.edge.id}`,
      );
    }
    assert(
      ['CALLS', 'ACCESSES', 'USES'].includes(edge.type),
      `Unsupported migrated reference type: ${edge.type}`,
    );
    {
      const expectedTypes =
        edge.type === 'CALLS'
          ? ['call_expression']
          : edge.type === 'ACCESSES'
            ? site.access === ':write'
              ? ['assignment_expression', 'augmented_assignment_expression']
              : ['member_expression', 'identifier']
            : ['identifier', 'type_identifier', 'shorthand_property_identifier'];
      const calls = sitesAt(source, file, site.line, site.col).filter((item) =>
        expectedTypes.includes(item.type),
      );
      const actual = group.map(({ site: span }) => `${span.endLine}:${span.endCol}`);
      assert(
        actual.every((end) => calls.some((call) => call.end === end)),
        `Reference span is not an expected AST site: ${oldId}`,
      );
      if (COLLAPSED_CALLS.has(oldId)) {
        // The registry chain ends in .build(), which has the same start but a
        // different target. Only its .register() calls belong to these IDs.
        const expected = calls
          .filter((call) => !file.endsWith('/pipeline.ts') || call.property === 'register')
          .map((call) => call.end);
        assert.deepEqual(actual.sort(), expected.sort(), `Incomplete nested call spans: ${oldId}`);
      }
    }
  }
  const comparison = { nodes: before.graph.nodes, edges: digest([...projected]) };
  assert.deepEqual(comparison, before.graph, 'Projected graph digest differs from baseline');
  return {
    version: 1,
    mode: 'point-to-span',
    baseline: before.graph,
    candidate: after.graph,
    comparison,
  };
}
