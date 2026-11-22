import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { afterEach, expect, it, vi } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  getScopeIndexStoreDir,
  TransitionalScopeTree,
} from '../../src/storage/scope-index-store.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';

const dirs = createTempDirPool('gn-pressure-parity-');
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('preserves cross-file calls, property accesses and PDG edges with a one-shard cache', async () => {
  const repo = dirs.dir();
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
  const pressure = vi.spyOn(v8, 'getHeapStatistics');
  const realSeal = TransitionalScopeTree.prototype.seal;
  const shardCounts: number[] = [];
  const seal = vi.spyOn(TransitionalScopeTree.prototype, 'seal').mockImplementation(function (
    this: TransitionalScopeTree,
    store,
  ) {
    realSeal.call(this, store, 1);
    shardCounts.push(readdirSync(getScopeIndexStoreDir(store)).length);
  });
  vi.stubEnv('GITNEXUS_DISK_SCOPE_INDEX', undefined);
  vi.stubEnv('INGESTION_EMIT_SCOPES', undefined);
  const run = async (ratio: number) => {
    pressure.mockReturnValue({ ...heap, used_heap_size: heap.heap_size_limit * ratio });
    const store = dirs.dir();
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
      expect(
        edges.some((e) => e.type === type),
        type,
      ).toBe(true);
    expect(nodes.some((n) => n.label === 'BasicBlock')).toBe(true);
    return { nodes, edges };
  };
  const resident = await run(0.4);
  expect(seal).not.toHaveBeenCalled();
  expect(await run(0.8)).toEqual(resident);
  expect(shardCounts.sort((a, b) => a - b)).toEqual([1, 67]);
});
