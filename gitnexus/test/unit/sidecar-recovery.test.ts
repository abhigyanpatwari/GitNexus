import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  _resetSidecarRecoveryWarningsForTest,
  finalizeLbugSidecarsAfterClose,
  inspectLbugSidecars,
  isPermissionRenameError,
  isReadOnlyShadowReplayError,
  listQuarantinedMissingShadowWals,
  preflightLbugSidecars,
  renameFailureMessage,
  shadowSidecarRecoveryMessage,
  TINY_ORPHAN_WAL_BYTES,
} from '../../src/core/lbug/sidecar-recovery.js';

const logger = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() });

describe('LadybugDB sidecar recovery', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    _resetSidecarRecoveryWarningsForTest();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-sidecar-recovery-'));
    dbPath = path.join(dir, 'lbug');
    await fs.writeFile(dbPath, 'db');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('classifies clean sidecars', async () => {
    await expect(inspectLbugSidecars(dbPath)).resolves.toEqual({ kind: 'clean', dbPath });
  });

  it('classifies WAL with shadow as replayable by LadybugDB', async () => {
    await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(128));
    await fs.writeFile(`${dbPath}.shadow`, Buffer.alloc(64));

    await expect(inspectLbugSidecars(dbPath)).resolves.toEqual({
      kind: 'wal-with-shadow',
      dbPath,
      walBytes: 128,
      shadowBytes: 64,
    });
  });

  it('preflight quarantines tiny orphan WAL without WARN noise', async () => {
    await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(34));
    const log = logger();

    const state = await preflightLbugSidecars(dbPath, {
      mode: 'read-only',
      logger: log,
      allowQuarantine: true,
    });

    expect(state.kind).toBe('clean');
    await expect(fs.stat(`${dbPath}.wal`)).rejects.toMatchObject({ code: 'ENOENT' });
    const files = await fs.readdir(dir);
    expect(files.some((file) => file.startsWith('lbug.wal.missing-shadow.'))).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('preflight tiny orphan WAL'));
  });

  it('does not silently quarantine large orphan WAL during preflight', async () => {
    await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(TINY_ORPHAN_WAL_BYTES + 1));
    const log = logger();

    const state = await preflightLbugSidecars(dbPath, {
      mode: 'read-only',
      logger: log,
      allowQuarantine: true,
    });

    expect(state).toEqual({
      kind: 'orphan-wal',
      dbPath,
      walBytes: TINY_ORPHAN_WAL_BYTES + 1,
    });
    await expect(fs.stat(`${dbPath}.wal`)).resolves.toBeDefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('finalize quarantines tiny orphan WAL after close', async () => {
    await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(34));
    const log = logger();

    await finalizeLbugSidecarsAfterClose(dbPath, { logger: log });

    await expect(fs.stat(`${dbPath}.wal`)).rejects.toMatchObject({ code: 'ENOENT' });
    const files = await fs.readdir(dir);
    expect(files.some((file) => file.startsWith('lbug.wal.missing-shadow.'))).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('can be disabled through GITNEXUS_DISABLE_LBUG_SIDECAR_PREFLIGHT', async () => {
    vi.stubEnv('GITNEXUS_DISABLE_LBUG_SIDECAR_PREFLIGHT', '1');
    await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(34));
    const log = logger();

    const state = await preflightLbugSidecars(dbPath, {
      mode: 'read-only',
      logger: log,
      allowQuarantine: true,
    });

    expect(state.kind).toBe('tiny-orphan-wal');
    await expect(fs.stat(`${dbPath}.wal`)).resolves.toBeDefined();
  });

  describe('renameFailureMessage classifier (PR #1747 review)', () => {
    const fsErr = (code: string, message = `simulated ${code}`): NodeJS.ErrnoException => {
      const e = new Error(message) as NodeJS.ErrnoException;
      e.code = code;
      return e;
    };

    it('classifies EACCES as a permission/file-lock error (not "rebuild")', () => {
      const out = renameFailureMessage('/tmp/lbug', fsErr('EACCES', 'permission denied'));
      expect(out).toContain('/tmp/lbug.wal');
      expect(out).toContain('EACCES');
      expect(out).toContain('permission');
      expect(out).not.toContain('Rebuild the index');
    });

    it('classifies EPERM as a permission/file-lock error', () => {
      const out = renameFailureMessage('/tmp/lbug', fsErr('EPERM'));
      expect(out).toContain('EPERM');
      expect(out).not.toContain('Rebuild the index');
    });

    it('classifies EBUSY as a permission/file-lock error (common on Windows under AV)', () => {
      const out = renameFailureMessage('/tmp/lbug', fsErr('EBUSY'));
      expect(out).toContain('EBUSY');
      expect(out).not.toContain('Rebuild the index');
    });

    it('falls through to shadowSidecarRecoveryMessage for the LadybugDB missing-shadow error', () => {
      const shadowErr = new Error('Cannot open file /tmp/lbug.shadow: No such file or directory');
      expect(renameFailureMessage('/tmp/lbug', shadowErr)).toBe(
        shadowSidecarRecoveryMessage('/tmp/lbug', shadowErr),
      );
    });

    it('falls through to shadowSidecarRecoveryMessage for ENOSPC (residual; flagged in plan)', () => {
      const err = fsErr('ENOSPC');
      expect(renameFailureMessage('/tmp/lbug', err)).toBe(
        shadowSidecarRecoveryMessage('/tmp/lbug', err),
      );
    });

    it('falls through to shadowSidecarRecoveryMessage for EROFS and EIO (residual; flagged in plan)', () => {
      const eRofs = fsErr('EROFS');
      const eIo = fsErr('EIO');
      expect(renameFailureMessage('/tmp/lbug', eRofs)).toBe(
        shadowSidecarRecoveryMessage('/tmp/lbug', eRofs),
      );
      expect(renameFailureMessage('/tmp/lbug', eIo)).toBe(
        shadowSidecarRecoveryMessage('/tmp/lbug', eIo),
      );
    });

    it('falls through to shadowSidecarRecoveryMessage for a generic Error without a code', () => {
      const generic = new Error('something else broke');
      expect(renameFailureMessage('/tmp/lbug', generic)).toBe(
        shadowSidecarRecoveryMessage('/tmp/lbug', generic),
      );
    });

    it('isPermissionRenameError returns true only for EACCES/EPERM/EBUSY', () => {
      expect(isPermissionRenameError(fsErr('EACCES'))).toBe(true);
      expect(isPermissionRenameError(fsErr('EPERM'))).toBe(true);
      expect(isPermissionRenameError(fsErr('EBUSY'))).toBe(true);
      expect(isPermissionRenameError(fsErr('ENOENT'))).toBe(false);
      expect(isPermissionRenameError(fsErr('ENOSPC'))).toBe(false);
      expect(isPermissionRenameError(new Error('shadow missing'))).toBe(false);
    });
  });

  describe('Centralized isReadOnlyShadowReplayError (PR #1747 review, F4 dedup)', () => {
    it('matches LadybugDB read-only shadow-replay error', () => {
      const err = new Error(
        "Runtime exception: Couldn't replay shadow pages under read-only mode. Please re-open the database with read-write mode to replay shadow pages.",
      );
      expect(isReadOnlyShadowReplayError(err)).toBe(true);
    });

    it('false-positive guard: rejects unrelated errors', () => {
      expect(isReadOnlyShadowReplayError(new Error('something else entirely'))).toBe(false);
      expect(isReadOnlyShadowReplayError(new Error('replay shadow pages'))).toBe(false); // missing "under read-only mode"
    });

    it('structural: lbug-adapter.ts no longer defines isReadOnlyShadowReplayError locally', () => {
      const source = readFileSync(
        path.join(__dirname, '..', '..', 'src', 'core', 'lbug', 'lbug-adapter.ts'),
        'utf-8',
      );
      // The original regex literal should appear nowhere in lbug-adapter.ts
      // (it now lives in sidecar-recovery.ts only).
      expect(source).not.toMatch(/replay shadow pages under read-only mode/);
    });

    it('structural: pool-adapter.ts no longer defines isReadOnlyShadowReplayError locally', () => {
      const source = readFileSync(
        path.join(__dirname, '..', '..', 'src', 'core', 'lbug', 'pool-adapter.ts'),
        'utf-8',
      );
      expect(source).not.toMatch(/replay shadow pages under read-only mode/);
    });

    it('structural: sidecar-recovery.ts carries exactly two LADYBUGDB-CONTRACT markers (one per shadow predicate)', () => {
      const source = readFileSync(
        path.join(__dirname, '..', '..', 'src', 'core', 'lbug', 'sidecar-recovery.ts'),
        'utf-8',
      );
      const markers = source.match(/\/\/ LADYBUGDB-CONTRACT:/g) ?? [];
      expect(markers.length).toBe(2);
    });
  });

  it('lists only missing-shadow WAL quarantine files for cleanup', async () => {
    await fs.writeFile(`${dbPath}.wal.missing-shadow.1-a`, '');
    await fs.writeFile(`${dbPath}.wal.missing-shadow.2-b`, '');
    await fs.writeFile(`${dbPath}.wal.corrupt.3-c`, '');
    await fs.writeFile(path.join(dir, 'other.wal.missing-shadow.4-d'), '');

    await expect(listQuarantinedMissingShadowWals(dbPath)).resolves.toEqual([
      `${dbPath}.wal.missing-shadow.1-a`,
      `${dbPath}.wal.missing-shadow.2-b`,
    ]);
  });

  describe('Counter-based warnOnce milestones (PR #1747 review, F6)', () => {
    // Use the public observable surface: drive `warnOnce` indirectly via
    // `preflightLbugSidecars` (which calls warnOnce for orphan-WAL) and count
    // logger.warn vs logger.debug invocations across many cycles. This avoids
    // coupling tests to `warnOnce`'s private signature.

    const triggerOrphanWalPreflight = async (path: string, log: ReturnType<typeof logger>) => {
      // Each call must restage a >TINY_ORPHAN_WAL_BYTES WAL because preflight
      // does not consume large WALs (it returns 'orphan-wal' and warns).
      await fs.writeFile(`${path}.wal`, Buffer.alloc(TINY_ORPHAN_WAL_BYTES + 1));
      await preflightLbugSidecars(path, {
        mode: 'read-only',
        logger: log,
        allowQuarantine: true,
      });
    };

    it('first occurrence warns; occurrences 2-9 debug; 10th warns with "10th occurrence" suffix', async () => {
      const log = logger();
      for (let i = 1; i <= 10; i++) {
        await triggerOrphanWalPreflight(dbPath, log);
      }
      expect(log.warn).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('lbug.wal without lbug.shadow'),
      );
      expect(log.warn).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('(10th occurrence of this condition)'),
      );
      expect(log.debug).toHaveBeenCalledTimes(8);
    });

    it('100th occurrence warns with "100th occurrence" suffix', async () => {
      const log = logger();
      for (let i = 1; i <= 100; i++) {
        await triggerOrphanWalPreflight(dbPath, log);
      }
      // Milestones at 1, 10, 100 → 3 warns total.
      expect(log.warn).toHaveBeenCalledTimes(3);
      expect(log.warn).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('(100th occurrence of this condition)'),
      );
    });

    it('different keys do not share counters (different dbPaths warn independently)', async () => {
      const log = logger();
      const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-sidecar-recovery-B-'));
      const dbPathB = path.join(dirB, 'lbug');
      await fs.writeFile(dbPathB, 'db');

      try {
        await triggerOrphanWalPreflight(dbPath, log);
        await triggerOrphanWalPreflight(dbPathB, log);

        // Each path fires its first-occurrence warn independently.
        expect(log.warn).toHaveBeenCalledTimes(2);
        expect(log.debug).toHaveBeenCalledTimes(0);
      } finally {
        await fs.rm(dirB, { recursive: true, force: true });
      }
    });

    it('_resetSidecarRecoveryWarningsForTest zeroes the counter so the next call fires warn again', async () => {
      const log = logger();
      await triggerOrphanWalPreflight(dbPath, log);
      await triggerOrphanWalPreflight(dbPath, log);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.debug).toHaveBeenCalledTimes(1);

      _resetSidecarRecoveryWarningsForTest();

      await triggerOrphanWalPreflight(dbPath, log);
      // Post-reset, counter is back to 1 — fires warn (not debug).
      expect(log.warn).toHaveBeenCalledTimes(2);
      expect(log.debug).toHaveBeenCalledTimes(1);
    });

    it('first-occurrence warn message does NOT include the occurrence-count suffix', async () => {
      const log = logger();
      await triggerOrphanWalPreflight(dbPath, log);
      expect(log.warn).toHaveBeenCalledTimes(1);
      const firstWarnMessage = (log.warn as any).mock.calls[0][0] as string;
      expect(firstWarnMessage).not.toContain('occurrence of this condition');
    });
  });
});
