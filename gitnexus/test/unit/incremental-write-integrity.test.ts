import { appendFile, stat, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { readEmbeddingNodeIds, seedEmbeddingsForFiles } from '../helpers/embedding-seed.js';
import {
  getStoragePaths,
  loadMeta,
  readRegistry,
  saveMeta,
} from '../../src/storage/repo-manager.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import * as fts from '../../src/core/search/fts-indexes.js';
import * as analyzerIdentity from '../../src/core/analyzer-identity.js';
import * as checkpoints from '../../src/core/lbug/wal-checkpoint-driver.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { reconcileGraphNodeIdentities } from '../../src/core/incremental/write-reconciliation.js';
import {
  MAX_INCREMENTAL_WRITES,
  MAX_INCREMENTAL_MUTATION_ROWS,
} from '../../src/core/incremental/compaction-policy.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const options = { skipAgentsMd: true, skipSkills: true };
const callbacks = { onProgress: () => {} };

describe('hybrid graph writes (real LadybugDB)', () => {
  it('keeps small edits incremental and compacts at the update deadline even without a source edit', async () => {
    const repo = await setupMiniRepo('gitnexus-hybrid-periodic-');
    const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
    try {
      await runFullAnalysis(repo.dbPath, options, callbacks);
      const seed = await loadMeta(storagePath);
      assert(seed?.graphCompaction);
      expect(seed.graphCompaction).toEqual({
        version: 1,
        compactBytes: (await stat(lbugPath)).size,
        incrementalWrites: 0,
      });
      expect((await runFullAnalysis(repo.dbPath, options, callbacks)).alreadyUpToDate).toBe(true);

      await touchHandler(repo.dbPath);
      const edit = await runFullAnalysis(repo.dbPath, options, callbacks);
      expect(edit.incrementalStats?.writeMode).toBe('incremental');
      const afterEdit = await loadMeta(storagePath);
      assert(afterEdit?.graphCompaction);
      expect(afterEdit.graphCompaction).toEqual({ ...seed.graphCompaction, incrementalWrites: 1 });

      await saveMeta(storagePath, {
        ...afterEdit,
        graphCompaction: {
          ...afterEdit.graphCompaction,
          incrementalWrites: MAX_INCREMENTAL_WRITES,
        },
      });
      const compacted = await runFullAnalysis(repo.dbPath, options, callbacks);
      expect(compacted.alreadyUpToDate).not.toBe(true);
      expect(compacted.incrementalStats).toMatchObject({ changedFiles: 0, writeMode: 'full' });
      const final = await loadMeta(storagePath);
      expect(final?.graphCompaction).toEqual({
        version: 1,
        compactBytes: (await stat(lbugPath)).size,
        incrementalWrites: 0,
      });
      expect(final?.incrementalInProgress).toBeUndefined();
      expect((await runFullAnalysis(repo.dbPath, options, callbacks)).alreadyUpToDate).toBe(true);
    } finally {
      await adapter.closeLbug();
      await repo.cleanup();
    }
  }, 120_000);

  it.each(['missing', 'grown'] as const)(
    'rebuilds a %s compact baseline before an unchanged-snapshot no-op',
    async (mode) => {
      const repo = await setupMiniRepo(`gitnexus-hybrid-${mode}-`);
      const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
      try {
        await runFullAnalysis(repo.dbPath, options, callbacks);
        const before = await loadMeta(storagePath);
        assert(before?.graphCompaction);
        if (mode === 'grown') {
          // Native allocation growth without a source change must still defeat
          // the clean-HEAD fast path. Compaction restores actual source content.
          await adapter.initLbug(lbugPath);
          await adapter.executePrepared(
            "MATCH (n:File) WHERE n.filePath = 'src/handler.ts' SET n.content = $content",
            { content: 'x'.repeat(20 * 1024 * 1024) },
          );
          await adapter.closeLbug();
          expect((await stat(lbugPath)).size - before.graphCompaction.compactBytes).toBeGreaterThan(
            16 * 1024 * 1024,
          );
        } else {
          await saveMeta(storagePath, { ...before, graphCompaction: undefined });
        }
        const result = await runFullAnalysis(repo.dbPath, options, callbacks);
        expect(result.incrementalStats?.writeMode).toBe('full');
        const after = await loadMeta(storagePath);
        expect(after?.graphCompaction?.incrementalWrites).toBe(0);
        expect(after?.graphCompaction?.compactBytes).toBe(before.graphCompaction.compactBytes);
      } finally {
        await adapter.closeLbug();
        await repo.cleanup();
      }
    },
    120_000,
  );

  it('selects COPY for a large mutation contained in one file', async () => {
    const repo = await setupMiniRepo('gitnexus-hybrid-large-file-');
    try {
      await runFullAnalysis(repo.dbPath, options, callbacks);
      initGitRepo(repo.dbPath);
      await writeFile(
        path.join(repo.dbPath, 'src/generated.ts'),
        Array.from(
          { length: MAX_INCREMENTAL_MUTATION_ROWS + 1 },
          (_, i) => `export function generated${i}() { return ${i}; }`,
        ).join('\n'),
      );
      commitAll(repo.dbPath, 'add one large source file');
      const logs: string[] = [];
      const result = await runFullAnalysis(repo.dbPath, options, {
        ...callbacks,
        onLog: (message) => logs.push(message),
      });
      expect(result.incrementalStats).toMatchObject({ changedFiles: 1, writeMode: 'full' });
      expect(logs.some((message) => message.includes('2000 graph rows'))).toBe(true);

      // The deleting half of a replacement matters too: the file still exists,
      // but none of its thousands of old symbols survive in the fresh graph.
      await writeFile(path.join(repo.dbPath, 'src/generated.ts'), 'export {};\n');
      commitAll(repo.dbPath, 'empty the large source file');
      logs.length = 0;
      const shrunk = await runFullAnalysis(repo.dbPath, options, {
        ...callbacks,
        onLog: (message) => logs.push(message),
      });
      expect(shrunk.incrementalStats).toMatchObject({ changedFiles: 1, writeMode: 'full' });
      expect(logs.some((message) => message.includes('2000 graph rows'))).toBe(true);
      await adapter.initLbug(getStoragePaths(repo.dbPath).lbugPath);
      expect(
        await adapter.executeQuery(
          "MATCH (n:Function) WHERE n.filePath = 'src/generated.ts' RETURN count(n) AS count",
        ),
      ).toEqual([{ count: 0 }]);
    } finally {
      await adapter.closeLbug();
      await repo.cleanup();
    }
  }, 120_000);

  it('keeps compaction counters independent across small repositories', async () => {
    const first = await setupMiniRepo('gitnexus-hybrid-first-');
    const second = await setupMiniRepo('gitnexus-hybrid-second-');
    try {
      await runFullAnalysis(first.dbPath, options, callbacks);
      await runFullAnalysis(second.dbPath, options, callbacks);
      const secondStorage = getStoragePaths(second.dbPath).storagePath;
      const before = await loadMeta(secondStorage);
      await touchHandler(first.dbPath);
      expect(
        (await runFullAnalysis(first.dbPath, options, callbacks)).incrementalStats?.writeMode,
      ).toBe('incremental');
      expect((await runFullAnalysis(second.dbPath, options, callbacks)).alreadyUpToDate).toBe(true);
      expect((await loadMeta(secondStorage))?.graphCompaction).toEqual(before?.graphCompaction);
      expect(
        (await loadMeta(getStoragePaths(first.dbPath).storagePath))?.graphCompaction
          ?.incrementalWrites,
      ).toBe(1);
    } finally {
      await adapter.closeLbug();
      await first.cleanup();
      await second.cleanup();
    }
  }, 120_000);

  it.each([false, true])(
    'preserves underreported vectors during periodic compaction unless explicitly dropped (drop=%s)',
    async (dropEmbeddings) => {
      const repo = await setupMiniRepo('gitnexus-hybrid-vectors-');
      const { storagePath } = getStoragePaths(repo.dbPath);
      try {
        await runFullAnalysis(repo.dbPath, options, callbacks);
        const seeded = [
          ...(
            await seedEmbeddingsForFiles(repo.dbPath, ['src/handler.ts', 'src/db.ts'], 2)
          ).values(),
        ]
          .flat()
          .sort();
        expect(seeded.length).toBeGreaterThan(0);
        const before = await loadMeta(storagePath);
        assert(before?.graphCompaction);
        expect(before.stats?.embeddings ?? 0).toBe(0);
        await saveMeta(storagePath, {
          ...before,
          graphCompaction: { ...before.graphCompaction, incrementalWrites: MAX_INCREMENTAL_WRITES },
        });
        const result = await runFullAnalysis(
          repo.dbPath,
          { ...options, dropEmbeddings },
          callbacks,
        );
        expect(result.alreadyUpToDate).not.toBe(true);
        if (dropEmbeddings) expect(result.incrementalStats).toBeUndefined();
        else expect(result.incrementalStats?.writeMode).toBe('full');
        expect((await readEmbeddingNodeIds(repo.dbPath)).sort()).toEqual(
          dropEmbeddings ? [] : seeded,
        );
        expect((await loadMeta(storagePath))?.graphCompaction?.incrementalWrites).toBe(0);
      } finally {
        await adapter.closeLbug();
        await repo.cleanup();
      }
    },
    120_000,
  );

  it('does not advance the compact baseline when preserving old vectors fails', async () => {
    const repo = await setupMiniRepo('gitnexus-hybrid-cache-failure-');
    const { storagePath } = getStoragePaths(repo.dbPath);
    try {
      await runFullAnalysis(repo.dbPath, options, callbacks);
      const before = await loadMeta(storagePath);
      assert(before?.graphCompaction);
      const due = {
        ...before,
        graphCompaction: { ...before.graphCompaction, incrementalWrites: MAX_INCREMENTAL_WRITES },
      };
      await saveMeta(storagePath, due);
      vi.spyOn(adapter, 'loadCachedEmbeddings').mockRejectedValueOnce(
        new Error('injected cache read failure'),
      );
      const deleteNodes = vi.spyOn(adapter, 'deleteNodesForFiles');
      const copy = vi.spyOn(adapter, 'loadGraphToLbug');
      await expect(runFullAnalysis(repo.dbPath, options, callbacks)).rejects.toThrow(
        'injected cache read failure',
      );
      expect(deleteNodes).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(await loadMeta(storagePath)).toEqual(due);
    } finally {
      await adapter.closeLbug();
      await repo.cleanup();
    }
  }, 120_000);
});

async function touchHandler(repoPath: string): Promise<void> {
  initGitRepo(repoPath);
  await appendFile(path.join(repoPath, 'src/handler.ts'), '\n// integrity probe\n');
  commitAll(repoPath, 'touch handler');
}

describe('incremental graph identity before publication', () => {
  it('chooses a full write before selective mutation when manual checkpoints are disabled', async () => {
    vi.stubEnv('GITNEXUS_ATOMIC_WINDOWS_SWAP', '0');
    const repo = await setupMiniRepo('gitnexus-test-checkpoint-opt-out-');
    const { storagePath } = getStoragePaths(repo.dbPath);
    try {
      await runFullAnalysis(repo.dbPath, options, callbacks);
      await touchHandler(repo.dbPath);
      vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '0');
      const deleteNodes = vi.spyOn(adapter, 'deleteNodesForFiles');
      const flush = vi.spyOn(adapter, 'tryFlushWAL');
      const logs: string[] = [];
      const result = await runFullAnalysis(repo.dbPath, options, {
        ...callbacks,
        onLog: (line) => logs.push(line),
      });
      expect(deleteNodes).not.toHaveBeenCalled();
      // The opt-out disables periodic/incremental checkpoints. Every full
      // build still certifies durability before recording its compact size.
      expect(flush).toHaveBeenCalledTimes(1);
      await expect(flush.mock.results[0].value).resolves.toBe(true);
      expect(result.incrementalStats).toBeUndefined();
      expect(logs).toContain(
        'Manual WAL checkpoints are disabled; switching to a full DB write before mutation.',
      );
      expect((await loadMeta(storagePath))?.incrementalInProgress).toBeUndefined();
    } finally {
      await adapter.closeLbug();
      await repo.cleanup();
    }
  }, 120_000);

  it('retries a transient checkpoint I/O failure at the final publication gate', async () => {
    const repo = await setupMiniRepo('gitnexus-test-final-checkpoint-retry-');
    const { storagePath } = getStoragePaths(repo.dbPath);
    try {
      await runFullAnalysis(repo.dbPath, options, callbacks);
      await touchHandler(repo.dbPath);
      // Isolate the final gate from the periodic driver's independent cadence.
      vi.spyOn(checkpoints, 'startWalCheckpointDriver').mockReturnValue({ stop: async () => {} });
      const flush = adapter.tryFlushWAL;
      const build = fts.buildSearchIndexesOrDegrade;
      let attempts = 0;
      vi.spyOn(fts, 'buildSearchIndexesOrDegrade').mockImplementation(async (...args) => {
        const result = await build(...args);
        vi.spyOn(adapter, 'tryFlushWAL').mockImplementation(async () => {
          if (++attempts === 1) {
            throw new Error(
              'Runtime exception: IO exception: Error renaming file db.wal to db.wal.checkpoint',
            );
          }
          return flush();
        });
        return result;
      });
      const result = await runFullAnalysis(repo.dbPath, options, callbacks);
      expect(attempts).toBe(2);
      expect(result.incrementalStats?.writeMode).toBe('incremental');
      expect((await loadMeta(storagePath))?.incrementalInProgress).toBeUndefined();
    } finally {
      await adapter.closeLbug();
      await repo.cleanup();
    }
  }, 120_000);
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
    graph.addNode({
      id: 'Destination:topic',
      label: 'Destination',
      properties: { name: 'topic', filePath: '' },
    });
    graph.addNode({
      // IDs must be valid before CSV encoding; malformed-ID rejection has its
      // own real persistence coverage in embedding-identity-integrity.test.ts.
      id: 'Function:src/Å.ts:王',
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
        reconcileGraphNodeIdentities(graph, adapter.forEachQueryRow, 'native CSV parity'),
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
      // Windows uses in-place writes even when a caller requests staging.
      const expectsStaging = atomicIncremental && process.platform !== 'win32';
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

        await touchHandler(repo.dbPath);
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
        expect(after?.graphCompaction).toEqual(before?.graphCompaction);
        expect(logs.filter((line) => line.includes('atomic-incremental'))).toEqual(
          expectsStaging ? [expect.stringContaining('staged')] : [],
        );
        expect(Boolean(after?.incrementalInProgress)).toBe(!expectsStaging);
        const registeredAfter = (await readRegistry()).find((entry) => entry.path === repo.dbPath);
        expect(registeredAfter?.indexedAt).toBe(registeredBefore?.indexedAt);
        expect(registeredAfter?.lastCommit).toBe(registeredBefore?.lastCommit);
        vi.restoreAllMocks();
        if (expectsStaging) {
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
          await adapter.initLbug(lbugPath);
          await expect(
            reconcileGraphNodeIdentities(
              recovered.pipelineResult.graph,
              adapter.forEachQueryRow,
              'recovered/reopened',
            ),
          ).resolves.toMatchObject({ nodes: expect.any(Number) });
          await adapter.closeLbug();
          expect((await runFullAnalysis(repo.dbPath, options, callbacks)).alreadyUpToDate).toBe(
            true,
          );
        }
      } finally {
        await adapter.closeLbug();
        await repo.cleanup();
      }
    },
    // Windows takes the in-place recovery path for every row: five analysis
    // calls including repair refusal, full recovery, and the final no-op.
    // Allow slow native checkpoints to finish before the test runner times out.
    process.platform === 'win32' ? 240_000 : 120_000,
  );
});
