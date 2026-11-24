import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import v8 from 'node:v8';
import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';
import { TransitionalScopeTree } from '../../../../src/storage/scope-index-store.js';
import { graphIdentity } from '../../../../test/helpers/graph-identity.js';
import { cdgSourcedInHazardFunction, graphDigest } from '../../../../test/helpers/pdg-graph.js';

async function dir(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'java-pdg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t: TestContext) {
  const root = await dir(t);
  await copyFile(
    new URL(
      '../../../../test/fixtures/java-products/cfg-hazards/java-hazards.java',
      import.meta.url,
    ),
    path.join(root, 'java-hazards.java'),
  );
  return root;
}
const workers = { workerThresholdsForTest: { minFiles: 1, minBytes: 1 }, workerPoolSize: 2 };
it(
  'Java worker PDG emits dependencies inside the nonterminating loop',
  { timeout: 60_000 },
  async (t) => {
    const run = await runPipelineFromRepo(await fixture(t), () => {}, { ...workers, pdg: true });
    assert.equal(run.usedWorkerPool, true);
    const blocks = new Set(
      [...run.graph.iterNodes()].filter((n) => n.label === 'BasicBlock').map((n) => n.id),
    );
    assert.ok(blocks.size > 0);
    const edges = [...run.graph.iterRelationships()];
    for (const type of ['CFG', 'REACHING_DEF', 'CDG']) {
      const matching = edges.filter((e) => e.type === type);
      assert.ok(matching.length > 0, type);
      for (const e of matching) {
        assert.ok(blocks.has(e.sourceId), e.sourceId);
        assert.ok(blocks.has(e.targetId), e.targetId);
        if (e.type === 'CDG') assert.ok(e.reason === 'T' || e.reason === 'F');
      }
    }
    assert.ok(cdgSourcedInHazardFunction(run, 'ready('));
  },
);
it('default and disabled Java PDG match the recorded graph', { timeout: 90_000 }, async (t) => {
  const expected = {
    byRelType: { CALLS: 10, DEFINES: 1, HAS_METHOD: 21, MEMBER_OF: 14 },
    byType: { Class: 1, Community: 4, File: 1, Method: 21 },
    edgeDigest: 'ef3ac1fffdde8dadd7c261938588ff86e9d0068572fb52e8b1ff771534ae762e',
    relationships: 46,
    symbols: 27,
  };
  for (const opts of [workers, { ...workers, pdg: false }]) {
    const run = await runPipelineFromRepo(await fixture(t), () => {}, opts);
    assert.deepEqual(graphDigest(run), expected);
  }
});
it(
  'preserves every Java PDG row when heap pressure spills the scope index',
  { timeout: 120_000 },
  async (t) => {
    const repo = await fixture(t);
    const heap = v8.getHeapStatistics();
    let ratio = 0.4;
    t.mock.method(v8, 'getHeapStatistics', () => ({
      ...heap,
      used_heap_size: heap.heap_size_limit * ratio,
    }));
    const seal = t.mock.method(TransitionalScopeTree.prototype, 'seal');
    const run = async () => {
      const { graph } = await runPipelineFromRepo(repo, () => {}, {
        pdg: true,
        parsedFileStorePath: await dir(t),
        workerPoolSize: 1,
        skipGraphPhases: true,
      });
      assert.ok([...graph.iterNodes()].some((n) => n.label === 'BasicBlock'));
      assert.ok([...graph.iterRelationships()].some((e) => e.type === 'CFG'));
      return graphIdentity(graph);
    };
    const resident = await run();
    assert.equal(seal.mock.callCount(), 0);
    ratio = 0.8;
    assert.deepEqual(await run(), resident);
    assert.equal(seal.mock.callCount(), 1);
    const spilled = seal.mock.calls[0].this;
    assert.ok(spilled instanceof TransitionalScopeTree);
    assert.equal(spilled.sealed, true);
  },
);
