import { it } from 'node:test';
import { expect } from 'expect';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';
import { TransitionalScopeTree } from '../../../../src/storage/scope-index-store.js';
import { cfgFixture } from '../support/cfg-fixture.js';
import { createTestEnvironment } from '../support/environment.js';

it(
  'TypeScript preserves the full graph when spilling under heap pressure',
  { timeout: 120_000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'gn-pdg-typescript-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = mkdtempSync(path.join(root, 'repo-'));
    copyFileSync(new URL('ten-functions.ts', cfgFixture), path.join(repo, 'ten-functions.ts'));
    const environment = createTestEnvironment();
    t.after(() => environment.restore());
    environment.set('GITNEXUS_DISK_SCOPE_INDEX', undefined);
    environment.set('INGESTION_EMIT_SCOPES', undefined);
    environment.set('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000');
    const heap = v8.getHeapStatistics();
    const pressure = t.mock.method(v8, 'getHeapStatistics');
    const seal = t.mock.method(TransitionalScopeTree.prototype, 'seal');
    const run = async (ratio: number) => {
      pressure.mock.mockImplementation(() => ({
        ...heap,
        used_heap_size: heap.heap_size_limit * ratio,
      }));
      const { graph } = await runPipelineFromRepo(repo, () => {}, {
        pdg: true,
        parsedFileStorePath: mkdtempSync(path.join(root, 'store-')),
        workerPoolSize: 1,
        skipGraphPhases: true,
      });
      const nodes = [...graph.iterNodes()].sort((a, b) => a.id.localeCompare(b.id));
      const edges = [...graph.iterRelationships()].sort((a, b) => a.id.localeCompare(b.id));
      expect(nodes.some((n) => n.label === 'BasicBlock')).toBe(true);
      expect(edges.some((e) => e.type === 'CFG')).toBe(true);
      return { nodes, edges };
    };
    const resident = await run(0.4);
    expect(seal.mock.callCount()).toBe(0);
    expect(await run(0.8)).toEqual(resident);
    expect(seal.mock.callCount()).toBe(1);
    expect(seal.mock.calls[0]?.this).toHaveProperty('sealed', true);
  },
);
