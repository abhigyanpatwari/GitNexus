import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const deferred = process.argv[2] === 'deferred';
const repo = await mkdtemp(path.join(tmpdir(), 'gitnexus-pipeline-retention-'));
try {
  await writeFile(
    path.join(repo, 'main.ts'),
    'export function entry() { return middle(); }\n' +
      'function middle() { return leaf(); }\n' +
      'function leaf() { return 1; }\n',
  );
  // The returned graph must not retain caller-owned progress state once all
  // phases finish. Build in a separate frame so this test retains only a WeakRef.
  async function build() {
    const progressState = { calls: 0 };
    const reference = new WeakRef(progressState);
    const result = await runPipelineFromRepo(
      repo,
      () => {
        progressState.calls++;
      },
      { workerPoolSize: 1, skipDerivedGraphPhases: deferred },
    );
    return { result, reference };
  }
  const { result, reference } = await build();
  if (deferred) {
    assert.ok(reference.deref(), 'pending phases must retain their progress callback');
    await result.runDeferredDerivedPhases();
    result.runDeferredDerivedPhases = undefined;
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    await setImmediate();
    global.gc();
    await setImmediate();
    if (reference.deref() === undefined) break;
  }
  assert.equal(reference.deref(), undefined, 'graph retained completed pipeline progress state');
  assert.ok(result.communityResult);
  assert.ok(result.processResult);
  // The graph's integrity callback must still resolve nodes after its caller's
  // pipeline context is collected.
  const entry = result.graph.nodes.find((node) => node.properties.name === 'entry');
  const leaf = result.graph.nodes.find((node) => node.properties.name === 'leaf');
  assert.ok(entry && leaf);
  result.graph.addRelationship({
    id: 'retention-check',
    sourceId: entry.id,
    targetId: leaf.id,
    type: 'CALLS',
    confidence: 1,
    reason: 'scope-resolved',
  });
  assert.equal(result.graph.getRelationship('retention-check')?.targetId, leaf.id);
  console.log(JSON.stringify({ released: true, deferred }));
} finally {
  await rm(repo, { recursive: true, force: true });
}
