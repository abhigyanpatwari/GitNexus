import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { createFileResultsFixture } from '../../../../test/helpers/file-results-fixture.js';
import { graphIdentity } from '../../../../test/helpers/graph-identity.js';
import {
  assertBatchedFileResults,
  assertDispatchFrame,
  withCacheKeys,
} from '../../../../test/helpers/worker-file-results.js';

const source = new URL(
  '../../../../test/fixtures/compiler-conformance/java-worker-file-cache/',
  import.meta.url,
);
const files = {
  'Base.java': await readFile(new URL('Base.java', source), 'utf8'),
  'Main.java': await readFile(new URL('Main.java', source), 'utf8'),
  'empty.ts': '',
  'client.ts': 'export function read(){return 1;}',
};
for (const pdg of [false, true]) {
  it(`encodes Java worker facts and scopes with PDG=${pdg}`, { timeout: 60_000 }, async () => {
    const inputs = withCacheKeys(
      Object.entries(files).map(([path, content]) => ({ path, content })),
    );
    assertDispatchFrame(inputs);
    await assertBatchedFileResults(inputs, pdg);
  });
  it(
    `preserves Java graph rows across dispatch rounds, cold, warm and mixed runs with PDG=${pdg}`,
    { timeout: 120_000 },
    async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'java-worker-file-cache-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const f = await createFileResultsFixture(root, files);
      const priorBudget = process.env.GITNEXUS_PARSE_ROUND_BYTES;
      t.after(() => {
        if (priorBudget === undefined) delete process.env.GITNEXUS_PARSE_ROUND_BYTES;
        else process.env.GITNEXUS_PARSE_ROUND_BYTES = priorBudget;
      });
      process.env.GITNEXUS_PARSE_ROUND_BYTES = '1';
      const perChunk = await f.run('none', pdg);
      const original = graphIdentity(perChunk.graph);
      assert.ok([...perChunk.graph.iterNodes()].some((n) => n.properties.name === 'Main'));
      delete process.env.GITNEXUS_PARSE_ROUND_BYTES;
      const full = await f.run('none', pdg);
      assert.deepEqual(graphIdentity(full.graph), original);
      const cold = await f.run('cold', pdg);
      assert.deepEqual(graphIdentity(cold.graph), original);
      const warm = await f.run('reuse', pdg);
      assert.equal(warm.reparsedFileCount, 0);
      assert.equal(warm.parseCacheHitFileCount, Object.keys(files).length);
      assert.equal(warm.usedWorkerPool, false);
      assert.deepEqual(graphIdentity(warm.graph), original);
      await writeFile(
        path.join(f.repo, 'Base.java'),
        files['Base.java'].replace('int value()', 'int extra() { return 2; }\n    int value()'),
      );
      await writeFile(path.join(f.repo, 'client.ts'), 'export function edited(){return 2;}');
      const mixed = await f.run('reuse', pdg);
      assert.equal(mixed.reparsedFileCount, 2);
      assert.equal(mixed.parseCacheHitFileCount, 2);
      assert.deepEqual(graphIdentity(mixed.graph), graphIdentity((await f.run('none', pdg)).graph));
      assert.notDeepEqual(graphIdentity(mixed.graph), original);
      assert.deepEqual(
        mixed.progress,
        [...mixed.progress].sort((a, b) => a - b),
      );
    },
  );
}
