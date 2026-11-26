import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';

describe('closure binding labels', () => {
  let graph: Awaited<ReturnType<typeof runPipelineFromRepo>>['graph'];
  before(
    async () => {
      const root = fileURLToPath(
        new URL(
          '../../../../test/fixtures/compiler-conformance/typescript-closure-binding-labels/',
          import.meta.url,
        ),
      );
      ({ graph } = await runPipelineFromRepo(root, () => {}, { workerPoolSize: 1 }));
    },
    { timeout: 90_000 },
  );

  function callTargets(file: string) {
    return [...graph.iterRelationshipsByType('CALLS')]
      .filter((edge) => graph.getNode(edge.sourceId)?.properties.filePath === file)
      .map((edge) => edge.targetId)
      .sort();
  }

  it('TypeScript: a NON-closure class field stays a Property', () => {
    const actual = graph.nodes
      .filter(
        (node) => node.properties.filePath === 'src/plain.ts' && node.properties.name === 'address',
      )
      .map((node) => node.label)
      .sort();
    assert.deepEqual(actual, ['Property']);
  });

  it('TypeScript: one CALLS edge for one call site', () => {
    assert.equal(callTargets('app.ts').length, 1);
  });

  it('TypeScript: a generator EXPRESSION binding is a Function, like the other forms', () => {
    assert.deepEqual(callTargets('gen.ts'), ['Function:gen.ts:g']);
  });

  it('TypeScript: a generator DECLARATION is unaffected', () => {
    assert.deepEqual(callTargets('decl.ts'), ['Function:decl.ts:g']);
  });

  it('TypeScript: a local closure does not call a same-named class method', () => {
    assert.deepEqual(callTargets('svc.ts'), ['Function:svc.ts:run.save@7:2']);
  });

  it('TypeScript: a shadowing local does not also call the shadowed function', () => {
    assert.deepEqual(callTargets('shadow.ts'), ['Function:shadow.ts:other']);
  });
});

describe('closure review findings', () => {
  let graph: Awaited<ReturnType<typeof runPipelineFromRepo>>['graph'];
  before(
    async () => {
      const root = fileURLToPath(
        new URL(
          '../../../../test/fixtures/compiler-conformance/typescript-closure-review-findings/',
          import.meta.url,
        ),
      );
      ({ graph } = await runPipelineFromRepo(root, () => {}, { workerPoolSize: 1 }));
    },
    { timeout: 90_000 },
  );

  it('TypeScript: a multi-line const arrow binding emits CALLS to target', () => {
    const actual = [...graph.iterRelationshipsByType('CALLS')]
      .filter((edge) => graph.getNode(edge.sourceId)?.properties.filePath === 'ml.ts')
      .map((edge) => edge.sourceId + ' -> ' + edge.targetId)
      .sort();
    assert.deepEqual(actual, [
      'Function:ml.ts:outer -> Function:ml.ts:outer.multi@3:2',
      'Function:ml.ts:outer -> Function:ml.ts:outer.single@2:2',
      'Function:ml.ts:outer.multi@3:2 -> Function:ml.ts:target',
      'Function:ml.ts:outer.single@2:2 -> Function:ml.ts:target',
    ]);
  });

  it('a TypeScript constructor PARAMETER PROPERTY keeps its class-qualified id', () => {
    const actual = graph.nodes
      .filter((node) => node.properties.filePath === 'svc.ts' && node.id.includes('port'))
      .map((node) => node.id)
      .sort();
    assert.deepEqual(actual, ['Property:svc.ts:Service.port']);
  });
});
