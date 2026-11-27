import { runInSequence } from '../../../test/helpers/run-in-sequence.mjs';
import { compareCodeUnits } from '../compare.mjs';
import assert from 'node:assert/strict';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';

const importer = 'src/app/U.java';

function appMethod(source, target) {
  return source.name + ' -> ' + target.filePath + ':' + target.name;
}

function importerEdge(kind, source, target) {
  return (
    kind +
    ' ' +
    source.label +
    ':' +
    source.name +
    ' -> ' +
    target.label +
    ':' +
    target.filePath +
    ':' +
    target.name
  );
}

function graphEdges(graph, app) {
  const edges = [];
  for (const rel of graph.iterRelationships()) {
    if (!['CALLS', 'IMPORTS', 'EXTENDS'].includes(rel.type)) continue;
    const source = graph.getNode(rel.sourceId);
    const target = graph.getNode(rel.targetId);
    if (app && rel.type === 'CALLS' && source.properties.filePath.startsWith('src/app/'))
      edges.push(appMethod(source.properties, target.properties));
    else if (!app && source.properties.filePath === importer)
      edges.push(
        importerEdge(
          rel.type,
          { ...source.properties, label: source.label },
          { ...target.properties, label: target.label },
        ),
      );
  }
  return edges.sort(compareCodeUnits);
}

/** Both import-storage representations must publish the same compiler-selected calls and graph facts. */
export async function checkImportStorage(dir, ref, spec) {
  assert.match(spec.status, /^(matches JLS|known semantic gap|imports match JLS)/);
  const selected = new Set();
  for (const call of ref.calls) {
    const source = ref.methods.get(call.from);
    const target = ref.methods.get(call.to);
    if (spec.app && source.filePath.startsWith('src/app/')) selected.add(appMethod(source, target));
    else if (!spec.app && source.filePath === importer)
      selected.add(importerEdge('CALLS', source, target));
  }
  for (const edge of spec.missingCompilerEdges ?? []) {
    assert.ok(selected.delete(edge), 'Recorded javac disagreement changed: ' + edge);
  }
  const expected = [...selected, ...spec.extraEdges].sort(compareCodeUnits);
  const prior = process.env.GITNEXUS_DISABLE_IMPORT_GROUPS;
  try {
    await runInSequence(['', '1'], async (disabled) => {
      process.env.GITNEXUS_DISABLE_IMPORT_GROUPS = disabled;
      const { graph } = await runPipelineFromRepo(dir, () => {});
      assert.deepEqual(
        graphEdges(graph, spec.app),
        expected,
        disabled ? 'expanded imports' : 'grouped imports',
      );
    });
  } finally {
    if (prior === undefined) delete process.env.GITNEXUS_DISABLE_IMPORT_GROUPS;
    else process.env.GITNEXUS_DISABLE_IMPORT_GROUPS = prior;
  }
}
