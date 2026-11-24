import { compareCodeUnits } from '../compare.mjs';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createKnowledgeGraph } from '../../../dist/core/graph/graph.js';
import { createSemanticModel } from '../../../dist/core/ingestion/model/semantic-model.js';
import { processParsing } from '../../../dist/core/ingestion/parsing-processor.js';
import { createWorkerPool } from '../../../dist/core/ingestion/workers/worker-pool.js';
import { javaScopeResolver } from '../../../dist/core/ingestion/languages/java/scope-resolver.js';
import { runScopeResolution } from '../../../dist/core/ingestion/scope-resolution/pipeline/run.js';

const worker = new URL('../../../dist/core/ingestion/workers/parse-worker.js', import.meta.url);

export async function checkWorkerOrder(dir, ref, spec) {
  const files = globSync('**/*.java', { cwd: dir })
    .sort(compareCodeUnits)
    .map((file) => ({
      path: file.replaceAll('\\', '/'),
      content: readFileSync(path.join(dir, file), 'utf8'),
    }));
  const owners = [...ref.methods].filter(
    ([, method]) => method.filePath === spec.file && method.name === spec.caller,
  );
  assert.equal(owners.length, 1, 'Unique compiler caller');
  const expected = [
    ...new Set(ref.calls.filter((call) => call.from === owners[0][0]).map((call) => call.to)),
  ].sort(compareCodeUnits);
  assert.ok(expected.length, 'Compiler selected no source methods in ' + spec.file);
  for (const input of [files, [...files].reverse()]) {
    javaScopeResolver.loadResolutionConfig?.('');
    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    const pool = createWorkerPool(worker, 1);
    let scopeExamined = false;
    try {
      const data = await processParsing(graph, input, model.symbols, pool);
      runScopeResolution(
        {
          graph,
          model,
          files: input,
          preExtractedParsedFiles: new Map(data.parsedFiles.map((file) => [file.filePath, file])),
          onResolved: ({ parsedFiles }) => {
            if (!('binding' in spec)) return;
            const app = parsedFiles.find((file) => file.filePath === spec.file);
            const scope = app.scopes.find((scope) => scope.id === app.moduleScope);
            assert.equal(scope.typeBindings.get('next')?.rawName ?? null, spec.binding);
            scopeExamined = true;
          },
        },
        javaScopeResolver,
      );
    } finally {
      await pool.terminate();
    }
    if ('binding' in spec) assert.ok(scopeExamined, 'Worker did not resolve the module scope');
    const actual = [...graph.iterRelationshipsByType('CALLS')]
      .flatMap((edge) => {
        const source = graph.getNode(edge.sourceId);
        const target = graph.getNode(edge.targetId);
        if (
          source?.properties.filePath !== spec.file ||
          source.properties.name !== spec.caller ||
          target?.label !== 'Method'
        )
          return [];
        const { filePath, startLine, startColumn } = target.properties;
        return [filePath + '#' + (startLine + 1) + ':' + startColumn];
      })
      .sort(compareCodeUnits);
    assert.deepEqual(
      actual,
      expected,
      'Worker-parsed CALLS from ' + spec.file + ' with first input ' + input[0].path,
    );
  }
}
