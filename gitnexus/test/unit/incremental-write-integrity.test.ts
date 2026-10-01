import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { getStoragePaths, loadMeta, readRegistry } from '../../src/storage/repo-manager.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import * as fts from '../../src/core/search/fts-indexes.js';
import * as analyzerIdentity from '../../src/core/analyzer-identity.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { reconcileGraphNodeIdentities } from '../../src/core/incremental/write-reconciliation.js';

afterEach(() => vi.restoreAllMocks());

const options = { skipAgentsMd: true, skipSkills: true };
const callbacks = { onProgress: () => {} };

describe('incremental graph identity before publication', () => {
  it('matches native CSV normalization for nullable, absent-range and Unicode identity fields', async () => {
    const repo = await setupMiniRepo('gitnexus-test-identity-parity-');
    const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'File:src/Å.ts',
      label: 'File',
      properties: { name: 'Å.ts', filePath: 'src/Å.ts' },
    });
    graph.addNode({
      id: 'Route:/王',
      label: 'Route',
      properties: { name: '/王', filePath: 'src/Å.ts' },
    });
    graph.addNode({
      id: 'Tool:王',
      label: 'Tool',
      properties: { name: '王', filePath: 'src/Å.ts' },
    });
    graph.addNode({ id: 'Destination:topic', label: 'Destination', properties: { name: 'topic' } });
    graph.addNode({
      id: 'Function:src/Å.ts:王\u0000\uD800',
      label: 'Function',
      properties: { name: '王\r\n\uD800', filePath: 'src/Å.ts' },
    });
    try {
      await adapter.initLbug(lbugPath, { skipFts: true });
      await adapter.loadGraphToLbug(
        graph,
        repo.dbPath,
        storagePath,
        undefined,
        undefined,
        undefined,
        'none',
      );
      await adapter.tryFlushWAL();
      await expect(
        reconcileGraphNodeIdentities(graph, adapter.executeQuery, 'native CSV parity'),
      ).resolves.toMatchObject({ nodes: 5 });
    } finally {
      await adapter.closeLbug();
      await repo.cleanup();
    }
  });

  it.each([
    { phase: 'after-copy', atomicIncremental: false },
    { phase: 'after-fts', atomicIncremental: false },
    { phase: 'after-fts', atomicIncremental: true },
    { phase: 'after-fts-finalization', atomicIncremental: false },
    { phase: 'checkpoint-false', atomicIncremental: false },
    { phase: 'checkpoint-throw', atomicIncremental: true },
  ])(
    'refuses freshness after $phase failure (atomic=$atomicIncremental)',
    async ({ phase, atomicIncremental }) => {
      const repo = await setupMiniRepo('gitnexus-test-write-integrity-');
      const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
      try {
        const healthy = await runFullAnalysis(repo.dbPath, options, callbacks);
        const before = await loadMeta(storagePath);
        const registeredBefore = (await readRegistry()).find((entry) => entry.path === repo.dbPath);
        const logs: string[] = [];
        const victim = [...healthy.pipelineResult.graph.iterNodes()].find(
          (node) => node.label === 'Function' && node.properties.filePath === 'src/validator.ts',
        );
        expect(victim?.id).toBeTruthy();

        await appendFile(path.join(repo.dbPath, 'src/handler.ts'), '\n// integrity probe\n');
        execFileSync('git', ['add', 'src/handler.ts'], { cwd: repo.dbPath });
        execFileSync(
          'git',
          [
            '-c',
            'user.name=test',
            '-c',
            'user.email=t@t',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '-qm',
            'touch handler',
          ],
          { cwd: repo.dbPath },
        );
        const damage = async () => {
          await adapter.executePrepared('MATCH (n:Function {id: $id}) DETACH DELETE n', {
            id: victim.id,
          });
        };
        if (phase === 'after-copy') {
          const load = adapter.loadGraphToLbug;
          vi.spyOn(adapter, 'loadGraphToLbug').mockImplementation(async (...args) => {
            const result = await load(...args);
            await damage();
            return result;
          });
        } else {
          const build = fts.buildSearchIndexesOrDegrade;
          vi.spyOn(fts, 'buildSearchIndexesOrDegrade').mockImplementation(async (...args) => {
            const result = await build(...args);
            if (phase === 'checkpoint-false') {
              vi.spyOn(adapter, 'tryFlushWAL').mockResolvedValue(false);
            } else if (phase === 'checkpoint-throw') {
              vi.spyOn(adapter, 'tryFlushWAL').mockRejectedValue(
                new Error('injected final checkpoint failure'),
              );
            } else {
              await damage();
              if (phase === 'after-fts-finalization') {
                vi.spyOn(analyzerIdentity, 'finalizeAnalyzerRunnerIdentity').mockImplementation(
                  () => {
                    throw new Error('injected analyzer finalization failure');
                  },
                );
              }
            }
            return result;
          });
        }

        await expect(
          runFullAnalysis(
            repo.dbPath,
            { ...options, atomicIncremental },
            {
              ...callbacks,
              onLog: (line) => logs.push(line),
            },
          ),
        ).rejects.toThrow(
          phase.startsWith('checkpoint')
            ? /checkpoint/i
            : phase === 'after-fts-finalization'
              ? /injected analyzer finalization failure/
              : /graph.*reconciliation/i,
        );
        const after = await loadMeta(storagePath);
        expect(after?.lastCommit).toBe(before?.lastCommit);
        expect(after?.indexedAt).toBe(before?.indexedAt);
        expect(logs.filter((line) => line.includes('atomic-incremental'))).toEqual(
          atomicIncremental ? [expect.stringContaining('staged')] : [],
        );
        expect(Boolean(after?.incrementalInProgress)).toBe(!atomicIncremental);
        const registeredAfter = (await readRegistry()).find((entry) => entry.path === repo.dbPath);
        expect(registeredAfter?.indexedAt).toBe(registeredBefore?.indexedAt);
        expect(registeredAfter?.lastCommit).toBe(registeredBefore?.lastCommit);
        vi.restoreAllMocks();
        if (atomicIncremental) {
          await adapter.initLbug(lbugPath);
          const retained = await adapter.executePrepared(
            'MATCH (n:Function {id: $id}) RETURN n.id AS id',
            {
              id: victim.id,
            },
          );
          expect(retained).toEqual([{ id: victim.id }]);
          await adapter.closeLbug();
        } else {
          expect(after?.incrementalInProgress).toMatchObject({
            phase: 'graph-reconciliation',
            checkpointSucceeded: false,
          });
          await expect(
            runFullAnalysis(repo.dbPath, { ...options, repairFts: true }, callbacks),
          ).rejects.toThrow(/mid-incremental-recovery/);
          expect((await loadMeta(storagePath))?.incrementalInProgress?.phase).toBe(
            'graph-reconciliation',
          );
          // The dirty marker drives recovery without a manual --force, and a
          // no-op rerun after recovery must stop rebuilding.
          const recovered = await runFullAnalysis(repo.dbPath, options, callbacks);
          expect(recovered.incrementalStats).toBeUndefined();
          expect((await loadMeta(storagePath))?.incrementalInProgress).toBeUndefined();
          expect((await runFullAnalysis(repo.dbPath, options, callbacks)).alreadyUpToDate).toBe(
            true,
          );
        }
      } finally {
        await adapter.closeLbug();
        await repo.cleanup();
      }
    },
    120_000,
  );
});
