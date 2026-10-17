/**
 * Integration test for the #2 atomic full-rebuild swap.
 *
 * A full rebuild builds the fresh index at a per-run `<lbugPath>.staging.<uuid>`
 * (#2658) and swaps it over the live index in one atomic rename (POSIX). Two
 * invariants:
 *  - success publishes a single valid `lbug` with no staging temp left behind,
 *    and a repeat rebuild replaces the inode (proving the swap, not an in-place
 *    edit); and
 *  - a failure BEFORE the swap leaves the previous index byte-for-byte intact
 *    (the crash-safety win — the live index is never wiped mid-rebuild).
 *
 * POSIX only: on Windows the build stays in place (buildPath === lbugPath), so
 * these swap invariants do not apply — see run-analyze's platform guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, execSync, spawnSync } from 'child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type LbugAdapter = typeof import('../../src/core/lbug/lbug-adapter.js');
type RepoManager = typeof import('../../src/storage/repo-manager.js');
type FsAtomic = typeof import('../../src/storage/fs-atomic.js');
type EscalationGate = typeof import('../../src/core/incremental/escalation-gate.js');
type CheckpointDriver = typeof import('../../src/core/lbug/wal-checkpoint-driver.js');
const ctx = vi.hoisted(() => ({
  loadMock: vi.fn(),
  realLoad: null as LbugAdapter['loadGraphToLbug'] | null,
  deleteMock: vi.fn(),
  realDelete: null as LbugAdapter['deleteNodesForFiles'] | null,
  closeMock: vi.fn(),
  realClose: null as LbugAdapter['closeLbug'] | null,
  closeBeforeExitMock: vi.fn(),
  realCloseBeforeExit: null as LbugAdapter['closeLbugBeforeExit'] | null,
  saveMetaMock: vi.fn(),
  realSaveMeta: null as RepoManager['saveMeta'] | null,
  renameMock: vi.fn(),
  realRename: null as FsAtomic['retryRename'] | null,
  escalateMock: vi.fn(),
  realEscalate: null as EscalationGate['shouldEscalateIncrementalWrite'] | null,
  finalCheckpointMock: vi.fn(),
  realFinalCheckpoint: null as CheckpointDriver['runCheckpointWithRetry'] | null,
}));
vi.mock('../../src/core/lbug/wal-checkpoint-driver.js', async (importOriginal) => {
  const actual = await importOriginal<CheckpointDriver>();
  ctx.realFinalCheckpoint = actual.runCheckpointWithRetry;
  ctx.finalCheckpointMock.mockImplementation(actual.runCheckpointWithRetry);
  return { ...actual, runCheckpointWithRetry: ctx.finalCheckpointMock };
});
// Delegating mocks keep real graph, metadata, and registry writes while
// allowing failures at the write and publication boundaries.
vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<LbugAdapter>();
  ctx.realLoad = actual.loadGraphToLbug;
  ctx.realDelete = actual.deleteNodesForFiles;
  ctx.realClose = actual.closeLbug;
  ctx.realCloseBeforeExit = actual.closeLbugBeforeExit;
  ctx.loadMock.mockImplementation(actual.loadGraphToLbug);
  ctx.deleteMock.mockImplementation(actual.deleteNodesForFiles);
  ctx.closeMock.mockImplementation(actual.closeLbug);
  ctx.closeBeforeExitMock.mockImplementation(actual.closeLbugBeforeExit);
  return {
    ...actual,
    loadGraphToLbug: ctx.loadMock,
    deleteNodesForFiles: ctx.deleteMock,
    closeLbug: ctx.closeMock,
    closeLbugBeforeExit: ctx.closeBeforeExitMock,
  };
});
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<RepoManager>();
  ctx.realSaveMeta = actual.saveMeta;
  ctx.saveMetaMock.mockImplementation(actual.saveMeta);
  return { ...actual, saveMeta: ctx.saveMetaMock };
});
vi.mock('../../src/storage/fs-atomic.js', async (importOriginal) => {
  const actual = await importOriginal<FsAtomic>();
  ctx.realRename = actual.retryRename;
  ctx.renameMock.mockImplementation(actual.retryRename);
  return { ...actual, retryRename: ctx.renameMock };
});
// Delegating, so a test can force the #2409 escalation valve on a two-file repo
// (the real predicate needs at least 50 files).
vi.mock('../../src/core/incremental/escalation-gate.js', async (importOriginal) => {
  const actual = await importOriginal<EscalationGate>();
  ctx.realEscalate = actual.shouldEscalateIncrementalWrite;
  ctx.escalateMock.mockImplementation(actual.shouldEscalateIncrementalWrite);
  return { ...actual, shouldEscalateIncrementalWrite: ctx.escalateMock };
});

import {
  analyzeFailureMayHaveMutatedLiveIndex,
  runFullAnalysis,
} from '../../src/core/run-analyze.js';
import { getStoragePaths, loadMeta, readRegistry } from '../../src/storage/repo-manager.js';
import { executeQuery } from '../../src/core/lbug/lbug-adapter.js';
import {
  initLbug as poolInit,
  executeQuery as poolQuery,
  closeLbug as poolClose,
} from '../../src/core/lbug/pool-adapter.js';
import { runWorkerAnalysis } from '../../src/server/analyze-worker-core.js';
import type { WorkerMessage } from '../../src/server/analyze-worker.js';
import { createTempDir } from '../helpers/test-db.js';

const isWin = process.platform === 'win32';

const identity = async (p: string): Promise<string> => {
  const s = await fs.stat(p);
  return `${s.ino}:${s.mtimeMs}:${s.size}`;
};
const lingeringTemp = async (lbugPath: string): Promise<string[]> => {
  const base = path.basename(lbugPath);
  const entries = await fs.readdir(path.dirname(lbugPath));
  // Staging temps are the legacy fixed `${base}.new*` and the current per-run
  // `${base}.staging.<uuid>*` (#2658). Match both so this leftover-temp guard
  // still catches a failed swap under the new naming.
  return entries.filter((e) => e.startsWith(`${base}.new`) || e.startsWith(`${base}.staging.`));
};

describe.skipIf(isWin)('atomic full-rebuild swap (#2)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gn-atomic-swap-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    ctx.loadMock.mockReset();
    ctx.loadMock.mockImplementation((...a: Parameters<LbugAdapter['loadGraphToLbug']>) =>
      ctx.realLoad!(...a),
    );
    ctx.deleteMock.mockReset();
    ctx.deleteMock.mockImplementation((...a: Parameters<LbugAdapter['deleteNodesForFiles']>) =>
      ctx.realDelete!(...a),
    );
    ctx.closeMock.mockReset();
    ctx.closeMock.mockImplementation(() => ctx.realClose!());
    ctx.closeBeforeExitMock.mockReset();
    ctx.closeBeforeExitMock.mockImplementation(() => ctx.realCloseBeforeExit!());
    ctx.saveMetaMock.mockReset();
    ctx.saveMetaMock.mockImplementation((...a: Parameters<RepoManager['saveMeta']>) =>
      ctx.realSaveMeta!(...a),
    );
    ctx.renameMock.mockReset();
    ctx.renameMock.mockImplementation((...a: Parameters<FsAtomic['retryRename']>) =>
      ctx.realRename!(...a),
    );
    ctx.escalateMock.mockReset();
    ctx.escalateMock.mockImplementation(
      (...a: Parameters<EscalationGate['shouldEscalateIncrementalWrite']>) =>
        ctx.realEscalate!(...a),
    );
    ctx.finalCheckpointMock.mockReset();
    ctx.finalCheckpointMock.mockImplementation(
      (...args: Parameters<CheckpointDriver['runCheckpointWithRetry']>) =>
        ctx.realFinalCheckpoint!(...args),
    );
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  const makeRepo = async () => {
    const tmp = await createTempDir('gn-atomic-swap-repo-');
    const repo = tmp.dbPath;
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    await fs.writeFile(
      path.join(repo, 'a.ts'),
      'export function greet(n: string) { return `hi ${n}`; }\nexport function caller() { return greet("x"); }\n',
    );
    execSync('git add -A && git -c user.name=t -c user.email=t@t commit -m init', {
      cwd: repo,
      stdio: 'pipe',
    });
    return { repo, cleanup: tmp.cleanup };
  };

  it('publishes one lbug with no temp leak; a repeat rebuild swaps the inode', async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo);
      await expect(fs.stat(lbugPath)).resolves.toBeTruthy();
      expect(await lingeringTemp(lbugPath)).toEqual([]);
      const first = await identity(lbugPath);

      await runFullAnalysis(repo, { force: true }, { onProgress: () => {} });
      expect(await lingeringTemp(lbugPath)).toEqual([]);
      // The atomic rename replaced the file — a new inode, not an in-place edit.
      expect(await identity(lbugPath)).not.toBe(first);
    } finally {
      await cleanup();
    }
  }, 180_000);

  it('leaves the previous index intact when a rebuild fails before the swap', async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} }); // v1
      const { lbugPath } = getStoragePaths(repo);
      const before = await identity(lbugPath);

      ctx.loadMock.mockRejectedValueOnce(new Error('injected mid-rebuild failure'));
      await expect(
        runFullAnalysis(repo, { force: true }, { onProgress: () => {} }),
      ).rejects.toThrow('injected mid-rebuild failure');

      // The build failed in the temp; the swap (skipped on failure) never
      // published it, so the live index is byte-for-byte untouched.
      expect(await identity(lbugPath)).toBe(before);
    } finally {
      await cleanup();
    }
  }, 180_000);

  it.each([
    { mode: 'wal', failure: 'publication' },
    { mode: 'checkpoint', failure: 'publication' },
    { mode: 'wal', failure: 'checkpoint' },
    { mode: 'checkpoint', failure: 'checkpoint' },
  ])(
    'preserves live $mode recovery data across a failed $failure and retry (#3591)',
    async ({ mode, failure }) => {
      const { repo, cleanup } = await makeRepo();
      const readerId = `live-recovery-${mode}`;
      try {
        await runFullAnalysis(repo, { skipFts: true }, { onProgress: () => {} });
        const { lbugPath, storagePath } = getStoragePaths(repo);
        const metadata = await loadMeta(storagePath);
        execFileSync(
          process.execPath,
          [
            fileURLToPath(new URL('../helpers/publication-live-wal.mjs', import.meta.url)),
            lbugPath,
            mode,
          ],
          { timeout: 30_000 },
        );
        await fs.writeFile(
          path.join(repo, 'a.ts'),
          'export function replacement() { return 2; }\n',
        );
        if (failure === 'publication') {
          ctx.renameMock.mockRejectedValueOnce(
            new Error('injected live recovery boundary failure'),
          );
        } else {
          let injected = false;
          ctx.finalCheckpointMock.mockImplementation(
            (options: Parameters<CheckpointDriver['runCheckpointWithRetry']>[0]) => {
              if (!options?.checkpointFn && !injected) {
                injected = true;
                return Promise.reject(new Error('injected live recovery boundary failure'));
              }
              return ctx.realFinalCheckpoint!(options);
            },
          );
        }
        await expect(
          runFullAnalysis(repo, { force: true, skipFts: true }, { onProgress: () => {} }),
        ).rejects.toThrow('injected live recovery boundary failure');
        expect((await loadMeta(storagePath))?.indexedAt).toBe(metadata?.indexedAt);
        // Observe the writer's receipt before a pool reader can repair anything.
        const residual = (await fs.readdir(path.dirname(lbugPath))).filter((name) =>
          /^lbug\.(wal|shadow|checkpoint)/.test(name),
        );
        expect(residual).toEqual([]);
        const coldNames = execFileSync(
          process.execPath,
          [
            '-e',
            `
          const { Database, Connection } = require('@ladybugdb/core');
          (async () => {
            const db = new Database(process.argv[1], 256 * 1024 * 1024, false, true);
            const conn = new Connection(db);
            const result = await conn.query('MATCH (f:Function) RETURN f.name AS name');
            console.log(JSON.stringify((await result.getAll()).map(row => row.name).sort()));
            await conn.close(); await db.close();
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
            lbugPath,
          ],
          { encoding: 'utf8', cwd: process.cwd(), timeout: 30_000 },
        );
        expect(JSON.parse(coldNames)).toEqual(['caller', 'greet', 'walOnly']);
        await poolInit(readerId, lbugPath);
        const rows = await poolQuery(
          readerId,
          'MATCH (f:Function) RETURN f.name AS name ORDER BY name',
        );
        expect(rows.map((row) => row.name)).toEqual(['caller', 'greet', 'walOnly']);
        await poolClose(readerId);
        await runFullAnalysis(repo, { force: true, skipFts: true }, { onProgress: () => {} });
        await poolInit(readerId, lbugPath);
        expect(await poolQuery(readerId, 'MATCH (f:Function) RETURN f.name AS name')).toEqual([
          { name: 'replacement' },
        ]);
      } finally {
        await poolClose(readerId);
        await cleanup();
      }
    },
    180_000,
  );

  it.each([
    { suffix: '.wal', skipNativeCloseOnExit: false },
    { suffix: '.shadow', skipNativeCloseOnExit: false },
    { suffix: '.wal.checkpoint', skipNativeCloseOnExit: false },
    { suffix: '.wal.checkpoint', skipNativeCloseOnExit: true },
    { suffix: '.wal.missing-shadow.1234-abcd', skipNativeCloseOnExit: false },
  ])(
    'refuses residual $suffix (skipNativeCloseOnExit=$skipNativeCloseOnExit) and preserves cold readers (#3591)',
    async ({ suffix, skipNativeCloseOnExit }) => {
      const { repo, cleanup } = await makeRepo();
      const readerId = `publication-residual-${suffix}`;
      try {
        await runFullAnalysis(repo, {}, { onProgress: () => {} });
        const { lbugPath, storagePath } = getStoragePaths(repo);
        const oldGraph = await fs.readFile(lbugPath);
        const oldMeta = await loadMeta(storagePath);
        await fs.writeFile(
          path.join(repo, 'a.ts'),
          'export function replacement() { return 42; }\n',
        );
        execSync('git -c user.name=t -c user.email=t@t commit -am replacement', {
          cwd: repo,
          stdio: 'pipe',
        });

        // Controlled publication-boundary fault: real indexing, checkpoint and
        // close run first. A residual recovery file must never accompany a
        // published main file, irrespective of the earlier checkpoint receipt.
        ctx.loadMock.mockClear();
        const closeMock = skipNativeCloseOnExit ? ctx.closeBeforeExitMock : ctx.closeMock;
        const realClose = skipNativeCloseOnExit ? ctx.realCloseBeforeExit! : ctx.realClose!;
        closeMock.mockImplementation(async () => {
          await realClose();
          if (ctx.loadMock.mock.calls.length === 0) return;
          const stage = (await fs.readdir(path.dirname(lbugPath))).find(
            (entry) =>
              entry.startsWith('lbug.staging.') &&
              !entry.includes('.wal') &&
              !entry.endsWith('.shadow'),
          );
          expect(stage).toBeDefined();
          await fs.writeFile(
            path.join(path.dirname(lbugPath), `${stage}${suffix}`),
            'injected residual',
          );
        });
        await expect(
          runFullAnalysis(repo, { force: true, skipNativeCloseOnExit }, { onProgress: () => {} }),
        ).rejects.toThrow(/publish|consolidat|sidecar/i);
        expect((await fs.readFile(lbugPath)).equals(oldGraph)).toBe(true);
        expect(await loadMeta(storagePath)).toMatchObject({
          lastCommit: oldMeta!.lastCommit,
          indexedAt: oldMeta!.indexedAt,
        });
        await poolInit(readerId, lbugPath);
        const rows = await poolQuery(readerId, 'MATCH (f:Function) RETURN f.name AS name');
        expect(rows.map((row) => (row as { name: string }).name).sort()).toEqual([
          'caller',
          'greet',
        ]);
        await poolClose(readerId);
        // A new native process has no pool cache or retained reader handle.
        const coldNames = execFileSync(
          process.execPath,
          [
            '-e',
            `
          const { Database, Connection } = require('@ladybugdb/core');
          (async () => {
            const db = new Database(process.argv[1], 256 * 1024 * 1024, false, true);
            const conn = new Connection(db);
            const result = await conn.query('MATCH (f:Function) RETURN f.name AS name');
            console.log(JSON.stringify((await result.getAll()).map(row => row.name).sort()));
            await conn.close(); await db.close();
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
            lbugPath,
          ],
          { encoding: 'utf8', timeout: 30_000 },
        );
        expect(JSON.parse(coldNames)).toEqual(['caller', 'greet']);

        // A failed stage must not make recovery a permanent failure loop.
        closeMock.mockImplementation(realClose);
        await runFullAnalysis(repo, { force: true }, { onProgress: () => {} });
        await poolInit(readerId, lbugPath);
        const recovered = await poolQuery(readerId, 'MATCH (f:Function) RETURN f.name AS name');
        expect(recovered.map((row) => (row as { name: string }).name).sort()).toEqual([
          'replacement',
        ]);
      } finally {
        await poolClose(readerId);
        await cleanup();
      }
    },
    180_000,
  );

  it.each(['rejected', 'unverified', 'manual-disabled'])(
    'keeps the published graph when the final full-rebuild checkpoint is %s (#3591)',
    async (outcome) => {
      const { repo, cleanup } = await makeRepo();
      try {
        await runFullAnalysis(repo, {}, { onProgress: () => {} });
        const { lbugPath, storagePath } = getStoragePaths(repo);
        const oldGraph = await fs.readFile(lbugPath);
        const oldMeta = await loadMeta(storagePath);
        if (outcome === 'manual-disabled') vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '0');
        if (outcome === 'rejected') {
          ctx.finalCheckpointMock.mockRejectedValueOnce(
            new Error('injected final checkpoint failure'),
          );
        } else {
          ctx.finalCheckpointMock.mockResolvedValueOnce({ attempts: 1, flushed: false });
        }
        await expect(
          runFullAnalysis(repo, { force: true }, { onProgress: () => {} }),
        ).rejects.toThrow(/checkpoint/i);
        expect((await fs.readFile(lbugPath)).equals(oldGraph)).toBe(true);
        expect(await loadMeta(storagePath)).toMatchObject({
          lastCommit: oldMeta!.lastCommit,
          indexedAt: oldMeta!.indexedAt,
        });
      } finally {
        vi.unstubAllEnvs();
        await cleanup();
      }
    },
    180_000,
  );

  it('recovers after a CLI process exits immediately before publication (#3591)', async () => {
    const { repo, cleanup } = await makeRepo();
    const readerId = 'interrupted-publication';
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      const { lbugPath, storagePath } = getStoragePaths(repo);
      const oldGraph = await fs.readFile(lbugPath);
      const oldMeta = await loadMeta(storagePath);
      await fs.writeFile(path.join(repo, 'a.ts'), 'export function replacement() { return 42; }\n');
      execSync('git -c user.name=t -c user.email=t@t commit -am replacement', {
        cwd: repo,
        stdio: 'pipe',
      });
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../helpers/interrupted-publication-runner.mjs', import.meta.url)),
          repo,
        ],
        { encoding: 'utf8', timeout: 120_000 },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(73);
      expect((await fs.readFile(lbugPath)).equals(oldGraph)).toBe(true);
      expect(await loadMeta(storagePath)).toMatchObject({
        indexedAt: oldMeta!.indexedAt,
        lastCommit: oldMeta!.lastCommit,
      });
      await poolInit(readerId, lbugPath);
      expect(
        (await poolQuery(readerId, 'MATCH (f:Function) RETURN f.name AS name'))
          .map((row) => row.name)
          .sort(),
      ).toEqual(['caller', 'greet']);
      await poolClose(readerId);
      await runFullAnalysis(repo, { force: true }, { onProgress: () => {} });
      expect(await lingeringTemp(lbugPath)).toEqual([]);
      await poolInit(readerId, lbugPath);
      expect(
        (await poolQuery(readerId, 'MATCH (f:Function) RETURN f.name AS name')).map(
          (row) => row.name,
        ),
      ).toEqual(['replacement']);
    } finally {
      await poolClose(readerId);
      await cleanup();
    }
  }, 180_000);

  // Commit a replacement graph, then force a rebuild whose staged load loses
  // every relationship, and assert the collapse guard rejects it unpublished.
  const expectCollapsedRebuildRejected = async (repo: string) => {
    const { lbugPath } = getStoragePaths(repo);
    const oldRegistry = await readRegistry();
    await fs.writeFile(
      path.join(repo, 'a.ts'),
      'export function replacement() { return "new graph"; }\n',
    );
    execSync('git -c user.name=t -c user.email=t@t commit -am replacement', {
      cwd: repo,
      stdio: 'pipe',
    });
    ctx.loadMock.mockImplementationOnce(
      async (...args: Parameters<LbugAdapter['loadGraphToLbug']>) => {
        const result = await ctx.realLoad!(...args);
        // Keep real nodes and a measurable DB, but lose every relationship
        // after the load so the actual collapse guard must reject it.
        await executeQuery('MATCH ()-[r:CodeRelation]->() DELETE r');
        return result;
      },
    );

    const failure = await runFullAnalysis(repo, { force: true }, { onProgress: () => {} }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message: expect.stringMatching(/produced [1-9]\d* relationships but only 0/),
    });
    expect(failure).toMatchObject({
      message: expect.stringContaining('GITNEXUS_LBUG_BUFFER_POOL_SIZE'),
    });
    expect(analyzeFailureMayHaveMutatedLiveIndex(failure)).toBe(false);
    expect(await lingeringTemp(lbugPath)).toEqual([]);
    expect(await readRegistry()).toEqual(oldRegistry);
  };

  it('rejects a collapsed first-time staged graph before publication', async () => {
    const { repo, cleanup } = await makeRepo();
    const { lbugPath, storagePath } = getStoragePaths(repo);
    try {
      await expectCollapsedRebuildRejected(repo);
      await expect(fs.stat(lbugPath)).rejects.toMatchObject({ code: 'ENOENT' });
      // Storage setup may leave its empty metadata shell, but no analysis
      // commit or completed graph statistics may be published.
      const failedMeta = await loadMeta(storagePath);
      expect(failedMeta?.lastCommit).toBe('');
      expect(failedMeta?.stats).toBeUndefined();
    } finally {
      await cleanup();
    }
  }, 180_000);

  it('rejects a collapsed rebuild and keeps the previous index readable', async () => {
    const { repo, cleanup } = await makeRepo();
    const repoId = 'atomic-collapse-existing';
    const { lbugPath, storagePath } = getStoragePaths(repo);
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      const oldGraph = await fs.readFile(lbugPath);
      const oldMeta = await loadMeta(storagePath);

      await expectCollapsedRebuildRejected(repo);

      expect((await fs.readFile(lbugPath)).equals(oldGraph)).toBe(true);
      expect(await loadMeta(storagePath)).toMatchObject({
        lastCommit: oldMeta!.lastCommit,
        indexedAt: oldMeta!.indexedAt,
      });
      await poolInit(repoId, lbugPath);
      const names = (await poolQuery(repoId, 'MATCH (f:Function) RETURN f.name AS n')).flatMap(
        (row) => Object.values(row as Record<string, unknown>).map(String),
      );
      expect(names.sort()).toEqual(['caller', 'greet']);
      const edges = await poolQuery(repoId, 'MATCH ()-[r:CodeRelation]->() RETURN count(r) AS n');
      expect(Number((edges[0] as Record<string, unknown>).n)).toBeGreaterThan(0);
    } finally {
      await poolClose(repoId);
      await cleanup();
    }
  }, 180_000);

  it.each(
    (['full', 'incremental'] as const).flatMap((writeMode) =>
      (['close', 'swap', 'metadata'] as const).map((failurePoint) => ({
        writeMode,
        failurePoint,
      })),
    ),
  )(
    'keeps registry freshness unchanged when $writeMode publication fails at $failurePoint',
    async ({ writeMode, failurePoint }) => {
      const { repo, cleanup } = await makeRepo();
      const repoId = `atomic-publication-${writeMode}-${failurePoint}`;
      try {
        await runFullAnalysis(repo, {}, { onProgress: () => {} });
        const { lbugPath, storagePath } = getStoragePaths(repo);
        const oldGraph = await fs.readFile(lbugPath);
        const oldMeta = await loadMeta(storagePath);
        const oldRegistry = await readRegistry();
        expect(oldRegistry).toHaveLength(1);
        expect(oldRegistry[0]).toMatchObject({
          lastCommit: oldMeta!.lastCommit,
          indexedAt: oldMeta!.indexedAt,
        });

        await fs.writeFile(
          path.join(repo, 'a.ts'),
          'export function replacement() { return "new graph"; }\n',
        );
        execSync('git -c user.name=t -c user.email=t@t commit -am replacement', {
          cwd: repo,
          stdio: 'pipe',
        });
        const nextCommit = execSync('git rev-parse HEAD', {
          cwd: repo,
          encoding: 'utf8',
        }).trim();
        expect(nextCommit).not.toBe(oldMeta!.lastCommit);

        const injected = new Error(`injected final ${failurePoint} failure`);
        ctx.loadMock.mockClear();
        ctx.deleteMock.mockClear();
        if (failurePoint === 'close') {
          ctx.closeMock.mockImplementation(async () => {
            // Actually release native handles, then inject the rejection only
            // after loading the new graph, not at the pre-rebuild close.
            await ctx.realClose!();
            if (ctx.loadMock.mock.calls.length > 0) throw injected;
          });
        } else if (failurePoint === 'swap') {
          ctx.renameMock.mockImplementation(
            async (...args: Parameters<FsAtomic['retryRename']>) => {
              const [from, to] = args;
              if (from.startsWith(`${lbugPath}.staging.`) && to === lbugPath) throw injected;
              await ctx.realRename!(...args);
            },
          );
        } else {
          ctx.saveMetaMock.mockImplementation(
            async (...args: Parameters<RepoManager['saveMeta']>) => {
              const [, meta] = args;
              if (meta.lastCommit === nextCommit && !meta.incrementalInProgress) throw injected;
              await ctx.realSaveMeta!(...args);
            },
          );
        }

        const failure = await runFullAnalysis(
          repo,
          writeMode === 'full' ? { force: true } : { atomicIncremental: true },
          { onProgress: () => {} },
        ).catch((error: unknown) => error);
        expect(failure).toBe(injected);
        expect(ctx.loadMock).toHaveBeenCalled();
        expect(ctx.deleteMock.mock.calls.length > 0).toBe(writeMode === 'incremental');
        expect(await readRegistry()).toEqual(oldRegistry);
        expect(await loadMeta(storagePath)).toMatchObject({ lastCommit: oldMeta!.lastCommit });
        expect(await lingeringTemp(lbugPath)).toEqual([]);

        // A metadata failure occurs after the swap; close/swap failures keep
        // the old bytes. Both cases must retain the old registry receipt.
        const published = failurePoint === 'metadata';
        expect(analyzeFailureMayHaveMutatedLiveIndex(failure)).toBe(published);
        expect((await fs.readFile(lbugPath)).equals(oldGraph)).toBe(!published);
        await poolInit(repoId, lbugPath);
        const names = (await poolQuery(repoId, 'MATCH (f:Function) RETURN f.name AS n')).flatMap(
          (row) => Object.values(row as Record<string, unknown>).map(String),
        );
        expect(names.sort()).toEqual(published ? ['replacement'] : ['caller', 'greet']);
      } finally {
        await poolClose(repoId);
        await cleanup();
      }
    },
    180_000,
  );

  it('marks a failure after an atomic publish as potentially live-mutating', async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      const failure = await runFullAnalysis(
        repo,
        {},
        {
          onProgress: (phase, percent) => {
            if (phase === 'done' && percent === 100) {
              throw new Error('injected post-publish failure');
            }
          },
        },
      ).catch((error: unknown) => error);

      expect(failure).toMatchObject({ message: 'injected post-publish failure' });
      expect(analyzeFailureMayHaveMutatedLiveIndex(failure)).toBe(true);
      await expect(fs.stat(getStoragePaths(repo).lbugPath)).resolves.toBeTruthy();
    } finally {
      await cleanup();
    }
  }, 180_000);

  it('the read pool serves the freshly-swapped index after a rebuild (#1 + #2 end-to-end)', async () => {
    const { repo, cleanup } = await makeRepo();
    const repoId = 'atomic-swap-e2e';
    const names = async (): Promise<string[]> =>
      (await poolQuery(repoId, 'MATCH (f:Function) RETURN f.name AS n')).flatMap((r) =>
        Object.values(r as Record<string, unknown>).map(String),
      );
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} }); // v1: greet
      const { lbugPath } = getStoragePaths(repo);

      await poolInit(repoId, lbugPath);
      expect(await names()).toContain('greet');

      // Rebuild with a renamed function so v1 and v2 differ observably.
      await fs.writeFile(
        path.join(repo, 'a.ts'),
        'export function renamedGreet(n: string) { return `hi ${n}`; }\nexport function caller() { return renamedGreet("x"); }\n',
      );
      execSync('git -c user.name=t -c user.email=t@t commit -am rename', {
        cwd: repo,
        stdio: 'pipe',
      });
      await runFullAnalysis(repo, { force: true }, { onProgress: () => {} }); // v2 → atomic swap

      // Same repoId: initLbug detects the swapped inode and re-opens the pool
      // onto the new index instead of serving the stale (unlinked) one.
      await poolInit(repoId, lbugPath);
      const v2 = await names();
      expect(v2).toContain('renamedGreet');
      // Proves the pool actually re-opened — a stale handle would still see v1.
      expect(v2).not.toContain('greet');
    } finally {
      await poolClose(repoId);
      await cleanup();
    }
  }, 180_000);

  it('opt-in atomic incremental copies then swaps, no temp leak, change reflected', async () => {
    const { repo, cleanup } = await makeRepo();
    const prev = process.env.GITNEXUS_ATOMIC_INCREMENTAL;
    process.env.GITNEXUS_ATOMIC_INCREMENTAL = '1';
    const repoId = 'atomic-incr-e2e';
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} }); // v1
      const { lbugPath } = getStoragePaths(repo);

      // Change a single file so the next run is incremental, adding a function.
      await fs.writeFile(
        path.join(repo, 'a.ts'),
        'export function greet(n: string) { return `hi ${n}`; }\nexport function caller() { return greet("x"); }\nexport function addedFn() { return 1; }\n',
      );
      execSync('git -c user.name=t -c user.email=t@t commit -am change', {
        cwd: repo,
        stdio: 'pipe',
      });

      await runFullAnalysis(repo, {}, { onProgress: () => {} }); // incremental + atomic swap
      expect(await lingeringTemp(lbugPath)).toEqual([]);

      await poolInit(repoId, lbugPath);
      const names = (await poolQuery(repoId, 'MATCH (f:Function) RETURN f.name AS n')).flatMap(
        (r) => Object.values(r as Record<string, unknown>).map(String),
      );
      expect(names).toContain('addedFn'); // the incremental change landed via the swap
    } finally {
      if (prev === undefined) delete process.env.GITNEXUS_ATOMIC_INCREMENTAL;
      else process.env.GITNEXUS_ATOMIC_INCREMENTAL = prev;
      await poolClose(repoId);
      await cleanup();
    }
  }, 180_000);

  it.each([
    {
      label: 'unset keeps the caller request (staged)',
      envValue: undefined,
      expectStaged: true,
      // The same `staging copy` label the failure evidence uses (#3530).
      stagedLines: [expect.stringMatching(/staging copy: apparent \d+ B, allocated /)],
      disabledNotices: [],
    },
    {
      label: '=0 overrides the caller request (in place)',
      envValue: '0',
      expectStaged: false,
      stagedLines: [],
      disabledNotices: [
        expect.stringContaining(
          'disabled by GITNEXUS_ATOMIC_INCREMENTAL=0 although the caller requested staging; ' +
            'a failed write will leave the live index partly written and the next run will ' +
            'rebuild it in full',
        ),
      ],
    },
  ])(
    'GITNEXUS_ATOMIC_INCREMENTAL $label when the caller passes atomicIncremental (#3530)',
    async ({ envValue, expectStaged, stagedLines, disabledNotices }) => {
      const { repo, cleanup } = await makeRepo();
      const repoId = 'atomic-incr-switch';
      vi.stubEnv('GITNEXUS_ATOMIC_INCREMENTAL', envValue);
      try {
        await runFullAnalysis(repo, {}, { onProgress: () => {} });
        const { lbugPath } = getStoragePaths(repo);
        const inodeBefore = (await fs.stat(lbugPath)).ino;

        await fs.writeFile(
          path.join(repo, 'a.ts'),
          'export function greet(n: string) { return `hi ${n}`; }\nexport function addedFn() { return 1; }\n',
        );
        execSync('git -c user.name=t -c user.email=t@t commit -am change', {
          cwd: repo,
          stdio: 'pipe',
        });

        const logs: string[] = [];
        await runFullAnalysis(
          repo,
          { atomicIncremental: true },
          { onProgress: () => {}, onLog: (line) => logs.push(line) },
        );

        expect(logs.filter((line) => line.startsWith('atomic-incremental: staged'))).toEqual(
          stagedLines,
        );
        expect(logs.filter((line) => line.startsWith('atomic-incremental: disabled'))).toEqual(
          disabledNotices,
        );
        expect((await fs.stat(lbugPath)).ino !== inodeBefore).toBe(expectStaged);
        expect(await lingeringTemp(lbugPath)).toEqual([]);

        await poolInit(repoId, lbugPath);
        const names = (await poolQuery(repoId, 'MATCH (f:Function) RETURN f.name AS n')).flatMap(
          (row) => Object.values(row as Record<string, unknown>).map(String),
        );
        expect(names).toContain('addedFn');
      } finally {
        vi.unstubAllEnvs();
        await poolClose(repoId);
        await cleanup();
      }
    },
    180_000,
  );

  it('stays silent about GITNEXUS_ATOMIC_INCREMENTAL=0 unless an incremental run was asked to stage (#3530)', async () => {
    const { repo, cleanup } = await makeRepo();
    vi.stubEnv('GITNEXUS_ATOMIC_INCREMENTAL', '0');
    try {
      // A full build stages regardless, so the switch changes nothing for it.
      const fullBuildLogs: string[] = [];
      await runFullAnalysis(
        repo,
        { atomicIncremental: true },
        { onProgress: () => {}, onLog: (line) => fullBuildLogs.push(line) },
      );
      await fs.writeFile(path.join(repo, 'a.ts'), 'export function changed() { return 1; }\n');
      execSync('git -c user.name=t -c user.email=t@t commit -am change', {
        cwd: repo,
        stdio: 'pipe',
      });
      // An incremental run nobody asked to stage has nothing to disable.
      const unrequestedLogs: string[] = [];
      await runFullAnalysis(
        repo,
        {},
        { onProgress: () => {}, onLog: (line) => unrequestedLogs.push(line) },
      );

      expect([...fullBuildLogs, ...unrequestedLogs]).not.toContainEqual(
        expect.stringContaining('disabled by GITNEXUS_ATOMIC_INCREMENTAL=0'),
      );
    } finally {
      vi.unstubAllEnvs();
      await cleanup();
    }
  }, 180_000);

  it('keeps the live graph unchanged when atomic incremental writeback fails', async () => {
    const { repo, cleanup } = await makeRepo();
    const repoId = 'atomic-incr-failure';
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo);
      const before = await identity(lbugPath);

      await fs.writeFile(
        path.join(repo, 'a.ts'),
        'export function greet(n: string) { return `hi ${n}`; }\nexport function caller() { return greet("x"); }\nexport function addedAfterRetry() { return 1; }\n',
      );
      execSync('git -c user.name=t -c user.email=t@t commit -am change', {
        cwd: repo,
        stdio: 'pipe',
      });

      ctx.deleteMock.mockRejectedValueOnce(new Error('injected incremental write failure'));
      const failure = await runFullAnalysis(
        repo,
        { atomicIncremental: true },
        { onProgress: () => {} },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: 'injected incremental write failure' });
      expect(analyzeFailureMayHaveMutatedLiveIndex(failure)).toBe(false);
      expect(await identity(lbugPath)).toBe(before);
      expect(await lingeringTemp(lbugPath)).toEqual([]);

      await poolInit(repoId, lbugPath);
      const beforeRetry = (
        await poolQuery(repoId, 'MATCH (f:Function) RETURN f.name AS n')
      ).flatMap((row) => Object.values(row as Record<string, unknown>).map(String));
      expect(beforeRetry).toContain('greet');
      expect(beforeRetry).not.toContain('addedAfterRetry');
      await poolClose(repoId);

      await runFullAnalysis(repo, { atomicIncremental: true }, { onProgress: () => {} });
      await poolInit(repoId, lbugPath);
      const afterRetry = (await poolQuery(repoId, 'MATCH (f:Function) RETURN f.name AS n')).flatMap(
        (row) => Object.values(row as Record<string, unknown>).map(String),
      );
      expect(afterRetry).toContain('addedAfterRetry');
    } finally {
      await poolClose(repoId);
      await cleanup();
    }
  }, 180_000);

  const EOF_FAILURE_TAIL = 'numBytesRead: 0 numBytesToRead: 4096 position: 8011825152';

  /** Commits an edit so the next analyze is incremental. */
  const commitEdit = async (repo: string): Promise<void> => {
    await fs.writeFile(path.join(repo, 'a.ts'), 'export function changed() { return 1; }\n');
    execSync('git -c user.name=t -c user.email=t@t commit -am change', {
      cwd: repo,
      stdio: 'pipe',
    });
  };

  it('names the off-switch and appends staging evidence to the error when an atomic-incremental write hits EOF (#3530)', async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      await commitEdit(repo);

      const failure = new Error(
        `IO exception: Cannot read from file: /repo/.gitnexus/lbug.staging.abc fileDescriptor: 19 ${EOF_FAILURE_TAIL}`,
      );
      const nativeMessage = failure.message;
      ctx.deleteMock.mockRejectedValueOnce(failure);
      const logs: string[] = [];
      const result = await runFullAnalysis(
        repo,
        { atomicIncremental: true },
        { onProgress: () => {}, onLog: (line) => logs.push(line) },
      ).catch((error: unknown) => error);

      expect(result).toBe(failure);
      // The message is the channel: watch and auto-sync surface it but not onLog.
      expect(failure.message.startsWith(`${nativeMessage}\n`)).toBe(true);
      expect(failure.message.split('\n')).toEqual(
        expect.arrayContaining([
          expect.stringContaining('The live index is untouched'),
          expect.stringContaining('GITNEXUS_ATOMIC_INCREMENTAL=0'),
          expect.stringMatching(/^Failure evidence — live index: apparent \d+ B, /),
          expect.stringMatching(/^Failure evidence — staging copy: apparent \d+ B, /),
        ]),
      );
      expect(logs.join('\n')).not.toContain('Failure evidence');
    } finally {
      await cleanup();
    }
  }, 180_000);

  it('does not name the off-switch when an atomic-incremental run escalated to a full write (#3530)', async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      await commitEdit(repo);

      // The #2409 valve wipes the staging copy and bulk-COPYs into it: a rebuild,
      // which stages whatever GITNEXUS_ATOMIC_INCREMENTAL says.
      ctx.escalateMock.mockReturnValueOnce(true);
      const failure = new Error(
        `IO exception: Cannot read from file: /repo/.gitnexus/lbug.staging.abc fileDescriptor: 19 ${EOF_FAILURE_TAIL}`,
      );
      ctx.loadMock.mockRejectedValueOnce(failure);
      const logs: string[] = [];
      const result = await runFullAnalysis(
        repo,
        { atomicIncremental: true },
        { onProgress: () => {}, onLog: (line) => logs.push(line) },
      ).catch((error: unknown) => error);

      expect(result).toBe(failure);
      expect(logs).toContainEqual(expect.stringContaining('incremental write escalated'));
      expect(failure.message).toContain('in the staged copy of the index');
      expect(failure.message).toContain('The live index is untouched');
      expect(failure.message).not.toContain('GITNEXUS_ATOMIC_INCREMENTAL');
      expect(analyzeFailureMayHaveMutatedLiveIndex(failure)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 180_000);

  it('forwards the remedy and evidence in the analyze worker terminal error message (#3530)', async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      await commitEdit(repo);

      const failure = new Error(
        `IO exception: Cannot read from file: /repo/.gitnexus/lbug.staging.abc fileDescriptor: 19 ${EOF_FAILURE_TAIL}`,
      );
      ctx.deleteMock.mockRejectedValueOnce(failure);
      const send = vi.fn<(message: WorkerMessage) => void>();
      await runWorkerAnalysis(
        repo,
        { atomicIncremental: true },
        {
          // The worker sets skipNativeCloseOnExit because it exits right after
          // reporting; this process keeps running, so close the handle for real.
          runFullAnalysis: (repoPath, options, callbacks, ...rest) =>
            runFullAnalysis(
              repoPath,
              { ...options, skipNativeCloseOnExit: false },
              callbacks,
              ...rest,
            ),
          assertAnalysisFinalized: async () => undefined,
          send,
          claimTerminal: () => true,
        },
      );

      expect(send).toHaveBeenCalledWith({
        type: 'error',
        message: expect.stringMatching(
          /GITNEXUS_ATOMIC_INCREMENTAL=0[\s\S]*Failure evidence — staging copy: apparent/,
        ),
      });
    } finally {
      await cleanup();
    }
  }, 180_000);

  it('tells an in-place write that hits EOF to rebuild, with live-index evidence only (#3530)', async () => {
    const { repo, cleanup } = await makeRepo();
    // The off-switch makes this run in place even though the caller asks for staging.
    vi.stubEnv('GITNEXUS_ATOMIC_INCREMENTAL', '0');
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      await commitEdit(repo);

      const failure = new Error(
        `IO exception: Cannot read from file: /repo/.gitnexus/lbug fileDescriptor: 19 ${EOF_FAILURE_TAIL}`,
      );
      ctx.deleteMock.mockRejectedValueOnce(failure);
      const logs: string[] = [];
      const result = await runFullAnalysis(
        repo,
        { atomicIncremental: true },
        { onProgress: () => {}, onLog: (line) => logs.push(line) },
      ).catch((error: unknown) => error);

      expect(result).toBe(failure);
      expect(failure.message.split('\n')).toEqual(
        expect.arrayContaining([
          expect.stringContaining('analyze --force'),
          expect.stringMatching(/^Failure evidence — live index: apparent \d+ B, /),
        ]),
      );
      expect(failure.message).not.toContain('live index is untouched');
      expect(failure.message).not.toContain('GITNEXUS_ATOMIC_INCREMENTAL');
      expect(failure.message).not.toContain('Failure evidence — staging copy');
    } finally {
      vi.unstubAllEnvs();
      await cleanup();
    }
  }, 180_000);

  it('marks failed in-place incremental writes as potentially live-mutating', async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      await fs.writeFile(path.join(repo, 'a.ts'), 'export function changed() { return 1; }\n');
      execSync('git -c user.name=t -c user.email=t@t commit -am change', {
        cwd: repo,
        stdio: 'pipe',
      });

      ctx.deleteMock.mockRejectedValueOnce(new Error('injected in-place failure'));
      const failure = await runFullAnalysis(repo, {}, { onProgress: () => {} }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ message: 'injected in-place failure' });
      expect(analyzeFailureMayHaveMutatedLiveIndex(failure)).toBe(true);
    } finally {
      await cleanup();
    }
  }, 180_000);

  it('publishes cleanly on the production close path (skipNativeCloseOnExit) (#2614 F5)', async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      // The CLI and serve-worker set skipNativeCloseOnExit (dodges #2264), so the
      // build handle is still open at swap time — the path production actually
      // ships, distinct from the default real-close the other tests exercise.
      // Prove the POSIX swap still publishes a single consolidated file with no
      // .new temp and no orphan sidecar.
      await runFullAnalysis(repo, { skipNativeCloseOnExit: true }, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo);
      await expect(fs.stat(lbugPath)).resolves.toBeTruthy();
      expect(await lingeringTemp(lbugPath)).toEqual([]);
      for (const s of ['.wal', '.shadow', '.wal.checkpoint'] as const) {
        await expect(fs.stat(`${lbugPath}${s}`)).rejects.toThrow(); // no orphan sidecar
      }
    } finally {
      await cleanup();
    }
  }, 180_000);
});
