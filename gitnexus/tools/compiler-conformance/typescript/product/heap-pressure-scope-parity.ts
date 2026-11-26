import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import assert from 'node:assert/strict';
import os from 'node:os';
import { it } from 'node:test';
import { expect } from 'expect';
import { createTestEnvironment } from '../support/environment.js';
import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';
import {
  getScopeIndexStoreDir,
  TransitionalScopeTree,
} from '../../../../src/storage/scope-index-store.js';
it('preserves cross-file calls, property accesses and PDG edges with a one-shard cache', async (t) => {
  const environment = createTestEnvironment();
  t.after(() => environment.restore());
  const dir = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gn-pressure-parity-'));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    return root;
  };
  const repo = dir();
  writeFileSync(
    path.join(repo, 'counter.ts'),
    'export class Counter { value = 1; read() { return this.value; } }',
  );
  writeFileSync(
    path.join(repo, 'entry.ts'),
    `
import { Counter } from './counter';
export function run(counter: Counter, enabled: boolean) {
  const value = counter.read();
  if (enabled) return value + 1;
  return value;
}`,
  );
  writeFileSync(
    path.join(repo, 'side.js'),
    'function target() { return 1; } export function later() { return target(); }',
  );
  // Cross the production cache's 64-shard limit too. Each module reads
  // the previous module's export so its shard participates in resolution.
  for (let i = 0; i < 65; i++) {
    const source =
      i === 0
        ? 'export const value = 0;'
        : `import { value as previous } from './part${i - 1}'; export const value = previous + 1;`;
    writeFileSync(path.join(repo, `part${i}.ts`), source);
  }
  const heap = v8.getHeapStatistics();
  const pressure = t.mock.method(v8, 'getHeapStatistics');
  const realSeal = TransitionalScopeTree.prototype.seal;
  const shardCounts: number[] = [];
  const seal = t.mock.method(
    TransitionalScopeTree.prototype,
    'seal',
    function (this: TransitionalScopeTree, store: Parameters<TransitionalScopeTree['seal']>[0]) {
      realSeal.call(this, store, 1);
      shardCounts.push(readdirSync(getScopeIndexStoreDir(store)).length);
    },
  );
  environment.set('GITNEXUS_DISK_SCOPE_INDEX', undefined);
  environment.set('INGESTION_EMIT_SCOPES', undefined);
  const run = async (ratio: number) => {
    pressure.mock.mockImplementation(() => ({
      ...heap,
      used_heap_size: heap.heap_size_limit * ratio,
    }));
    const store = dir();
    const { graph } = await runPipelineFromRepo(repo, () => {}, {
      pdg: true,
      parsedFileStorePath: store,
    });
    const edges = [...graph.iterRelationships()].sort((a, b) => a.id.localeCompare(b.id));
    const nodes = [...graph.iterNodes()].sort((a, b) => a.id.localeCompare(b.id));
    expect(
      edges.some(
        (e) =>
          e.type === 'CALLS' &&
          e.sourceId.includes('entry.ts') &&
          e.targetId.includes('counter.ts'),
      ),
    ).toBe(true);
    expect(
      edges.some(
        (e) =>
          e.type === 'CALLS' && e.sourceId.includes('side.js') && e.targetId.includes('side.js'),
      ),
    ).toBe(true);
    for (const type of ['ACCESSES', 'CFG', 'REACHING_DEF', 'CDG'])
      assert.ok(
        edges.some((e) => e.type === type),
        type,
      );
    expect(nodes.some((n) => n.label === 'BasicBlock')).toBe(true);
    return { nodes, edges };
  };
  const resident = await run(0.4);
  assert.equal(seal.mock.callCount(), 0);
  expect(await run(0.8)).toEqual(resident);
  expect(shardCounts.sort((a, b) => a - b)).toEqual([1, 67]);
});
