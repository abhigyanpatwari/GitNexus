import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  _resetSidecarRecoveryWarningsForTest,
  cleanParkedDirtyRecoverySidecars,
  cleanParkedLbugSidecars,
  cleanQuarantinedMissingShadowWals,
  finalizeLbugSidecarsAfterClose,
  guardWalQuarantine,
  inspectLbugSidecars,
  isMissingShadowSidecarError,
  isPermissionRenameError,
  isReadOnlyShadowReplayError,
  listParkedDirtyRecoverySidecars,
  listParkedLbugSidecars,
  listQuarantinedMissingShadowWals,
  preflightLbugSidecars,
  presentShadowUnreachableMessage,
  quarantineSidecarsForDirtyRecovery,
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
    // The parking-failure cases below spy on fs.rename — restore before the
    // teardown rm so no path-filtered rejection leaks into later tests.
    vi.restoreAllMocks();
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

  describe('isMissingShadowSidecarError (Windows-locale-robust, issue #2382)', () => {
    // Non-ASCII-safe Windows shadow path used across the Windows-format cases.
    const winShadow = String.raw`F:\McMod\repo\.gitnexus\lbug.shadow`;

    it('matches the exact #2382 Windows (English) string', () => {
      expect(
        isMissingShadowSidecarError(
          new Error(
            `IO exception: Cannot open file. path: ${winShadow} - Error 2: The system cannot find the file specified.`,
          ),
        ),
      ).toBe(true);
    });

    it('matches Windows Error 2 with LOCALIZED trailing text (keys on the code, not the phrase)', () => {
      // Simulated non-English Windows: the OS reason is localized but the Win32
      // code stays 2. R2 requires recognition here — the reporter's platform.
      expect(
        isMissingShadowSidecarError(
          new Error(
            `IO exception: Cannot open file. path: ${winShadow} - Error 2: 系统找不到指定的文件。`,
          ),
        ),
      ).toBe(true);
    });

    it('matches the POSIX form (unchanged — R5)', () => {
      expect(
        isMissingShadowSidecarError(
          new Error(
            'Cannot open file /home/u/repo/.gitnexus/lbug.shadow: No such file or directory',
          ),
        ),
      ).toBe(true);
    });

    it('rejects Error 3 path-not-found (non-ASCII garble artifact, shadow present — data-loss guard)', () => {
      expect(
        isMissingShadowSidecarError(
          new Error(
            `Cannot open file. path: ${winShadow} - Error 3: The system cannot find the path.`,
          ),
        ),
      ).toBe(false);
    });

    it('rejects Error 5 access-denied (present-but-locked)', () => {
      expect(
        isMissingShadowSidecarError(
          new Error(`Cannot open file. path: ${winShadow} - Error 5: Access is denied.`),
        ),
      ).toBe(false);
    });

    it('rejects Error 32 sharing-violation and does not confuse it with Error 2', () => {
      expect(
        isMissingShadowSidecarError(
          new Error(
            `Cannot open file. path: ${winShadow} - Error 32: The process cannot access the file because it is being used by another process.`,
          ),
        ),
      ).toBe(false);
    });

    it('rejects a path-embedded "error 2" when the real reason is a locked code (suffix-anchored — KTD2)', () => {
      expect(
        isMissingShadowSidecarError(
          new Error(
            String.raw`Cannot open file. path: F:\error 2\repo\.gitnexus\lbug.shadow - Error 32: The process cannot access the file.`,
          ),
        ),
      ).toBe(false);
    });

    it('rejects an EARLIER .shadow-suffixed dir + later "error 2" segment with a real Error 32 (last-anchor — Finding A)', () => {
      // Regression for the first-`.shadow` false-positive: a `.shadow`-suffixed
      // parent dir (e.g. a branch=subdir dir) before the real `lbug.shadow`,
      // plus a path-embedded `error 2`, must not read the path number as the
      // Win32 code when the true trailing code is an excluded one (32 = locked).
      expect(
        isMissingShadowSidecarError(
          new Error(
            String.raw`IO exception: Cannot open file. path: F:\snap.shadow\error 2\repo\.gitnexus\lbug.shadow - Error 32: The process cannot access the file.`,
          ),
        ),
      ).toBe(false);
    });

    it('rejects an earlier .shadow-suffixed dir + "error 2" segment with a real Error 5 (last-anchor — Finding A)', () => {
      expect(
        isMissingShadowSidecarError(
          new Error(
            String.raw`Cannot open file. path: F:\repos\.shadow\error 2\project\.gitnexus\lbug.shadow - Error 5: Access is denied.`,
          ),
        ),
      ).toBe(false);
    });

    it('rejects a .shadow-backup dir (hyphen boundary) + "error 2" segment with a real Error 3 (last-anchor — Finding A)', () => {
      // `.shadow-backup` matches `/\.shadow\b/` (hyphen is a word boundary), so
      // first-match anchoring would slice from it; last-match must still land on
      // the real `lbug.shadow` and read the true Error 3 (present-shadow garble).
      expect(
        isMissingShadowSidecarError(
          new Error(
            String.raw`Cannot open file. path: F:\repos\.shadow-backup\error 2\p\.gitnexus\lbug.shadow - Error 3: The system cannot find the path.`,
          ),
        ),
      ).toBe(false);
    });

    it('rejects POSIX permission-denied on the shadow', () => {
      expect(
        isMissingShadowSidecarError(
          new Error('Cannot open file /home/u/repo/.gitnexus/lbug.shadow: Permission denied'),
        ),
      ).toBe(false);
    });

    it('rejects a missing non-shadow file (WAL / main DB)', () => {
      expect(
        isMissingShadowSidecarError(
          new Error('Cannot open file /home/u/repo/.gitnexus/lbug.wal: No such file or directory'),
        ),
      ).toBe(false);
    });

    it('rejects unrelated errors', () => {
      expect(isMissingShadowSidecarError(new Error('something else entirely'))).toBe(false);
    });

    it('stays distinct from isReadOnlyShadowReplayError (predicates did not merge — KTD5)', () => {
      const winMissing = new Error(
        `Cannot open file. path: ${winShadow} - Error 2: The system cannot find the file specified.`,
      );
      expect(isReadOnlyShadowReplayError(winMissing)).toBe(false);
      const replay = new Error(
        "Runtime exception: Couldn't replay shadow pages under read-only mode.",
      );
      expect(isMissingShadowSidecarError(replay)).toBe(false);
    });
  });

  describe('guardWalQuarantine warn anti-spam (warnOnce milestones — S2/S3)', () => {
    it('warns once, not per-call, on a repeated present-shadow refusal', async () => {
      await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(128));
      await fs.writeFile(`${dbPath}.shadow`, Buffer.alloc(64));
      const log = logger();
      const trigger = new Error('trigger');

      await expect(guardWalQuarantine(dbPath, 'read-only', trigger, log)).rejects.toThrow(
        /present but unreachable/,
      );
      await expect(guardWalQuarantine(dbPath, 'read-only', trigger, log)).rejects.toThrow(
        /present but unreachable/,
      );

      // First refusal warns (milestone 1); the second same-key occurrence is
      // downgraded to debug by warnOnce rather than warning every request.
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('the .shadow sidecar is present on disk'),
      );
      expect(log.debug).toHaveBeenCalled();
    });

    it('warns once, not per-call, on a repeated large-orphan-WAL refusal', async () => {
      await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(TINY_ORPHAN_WAL_BYTES + 1));
      const log = logger();
      const trigger = new Error('trigger');

      await expect(guardWalQuarantine(dbPath, 'writable', trigger, log)).rejects.toThrow(
        /Rebuild the index/,
      );
      await expect(guardWalQuarantine(dbPath, 'writable', trigger, log)).rejects.toThrow(
        /Rebuild the index/,
      );

      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.debug).toHaveBeenCalled();
    });
  });

  describe('presentShadowUnreachableMessage (present-but-locked, not missing — S2)', () => {
    const dbPath = '/repo/.gitnexus/lbug';
    const original = new Error(
      String.raw`IO exception: Cannot open file. path: F:\repo\.gitnexus\lbug.shadow - Error 5: Access is denied.`,
    );

    it('describes a present-but-unreachable sidecar and does NOT instruct a rebuild', () => {
      const message = presentShadowUnreachableMessage(dbPath, original);
      expect(message).toMatch(/present but unreachable/);
      expect(message).toMatch(/path reachability or a file lock/);
      // The distinguishing property vs shadowSidecarRecoveryMessage: the shadow
      // is present, so it must not tell the operator to rebuild the index.
      expect(message).not.toMatch(/Rebuild the index/);
    });

    it('preserves the Original error tail so downstream recognition still matches', () => {
      const message = presentShadowUnreachableMessage(dbPath, original);
      expect(message).toContain('Original error:');
      expect(isMissingShadowSidecarError(new Error(message))).toBe(false); // Error 5, still excluded
      // Contrast: shadowSidecarRecoveryMessage tells the operator to rebuild.
      expect(shadowSidecarRecoveryMessage(dbPath, original)).toMatch(/Rebuild the index/);
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

  describe('quarantineSidecarsForDirtyRecovery (#2409 defect 2)', () => {
    it('parks both WAL and shadow verbatim under fixed .dirty-recovery names', async () => {
      await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(8192, 0xab));
      await fs.writeFile(`${dbPath}.shadow`, Buffer.alloc(4096, 0xcd));
      const messages: string[] = [];

      const result = await quarantineSidecarsForDirtyRecovery(dbPath, (m) => messages.push(m));

      expect(result).toEqual({
        moved: [`${dbPath}.wal.dirty-recovery`, `${dbPath}.shadow.dirty-recovery`],
        removed: [],
        failed: [],
      });
      // Originals gone — the next open has nothing to replay.
      await expect(inspectLbugSidecars(dbPath)).resolves.toEqual({ kind: 'clean', dbPath });
      // Bytes preserved for post-mortem, not deleted.
      expect(
        Buffer.compare(readFileSync(`${dbPath}.wal.dirty-recovery`), Buffer.alloc(8192, 0xab)),
      ).toBe(0);
      expect(
        Buffer.compare(readFileSync(`${dbPath}.shadow.dirty-recovery`), Buffer.alloc(4096, 0xcd)),
      ).toBe(0);
      expect(messages.join('\n')).toContain(
        'Parked lbug.wal.dirty-recovery, lbug.shadow.dirty-recovery',
      );
    });

    it('is a silent no-op when no sidecars exist', async () => {
      const messages: string[] = [];
      const result = await quarantineSidecarsForDirtyRecovery(dbPath, (m) => messages.push(m));
      expect(result).toEqual({ moved: [], removed: [], failed: [] });
      expect(messages).toEqual([]);
    });

    it('a transient EBUSY that clears within the retry budget parks normally (FIX 1 — the park used to have ZERO retry for the lock class the wipe path retries)', async () => {
      await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(2048, 0x55));
      // First two rename attempts on the .wal source fail EBUSY (AV scan /
      // handle-release lag), then the spy calls through — the shared-budget
      // retry loop must absorb this without classifying anything as removed
      // or failed. Typed captured original, path-filtered (precedent:
      // repo-manager-transient-error.test.ts EACCES case, minus its as-any).
      const originalRename: typeof fs.rename = fs.rename;
      let walRenameAttempts = 0;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(from).endsWith('.wal')) {
          walRenameAttempts += 1;
          if (walRenameAttempts <= 2) {
            const err = new Error('resource busy or locked') as NodeJS.ErrnoException;
            err.code = 'EBUSY';
            throw err;
          }
        }
        return originalRename(from, to);
      });

      const result = await quarantineSidecarsForDirtyRecovery(dbPath, () => {});

      expect(result).toEqual({
        moved: [`${dbPath}.wal.dirty-recovery`],
        removed: [],
        failed: [],
      });
      expect(walRenameAttempts).toBe(3);
      expect(
        Buffer.compare(readFileSync(`${dbPath}.wal.dirty-recovery`), Buffer.alloc(2048, 0x55)),
      ).toBe(0);
      await expect(inspectLbugSidecars(dbPath)).resolves.toEqual({ kind: 'clean', dbPath });
    });

    it('parks a lone WAL and replaces a stale parked copy from an earlier crash', async () => {
      await fs.writeFile(`${dbPath}.wal.dirty-recovery`, 'stale parked bytes');
      await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(2048, 0x11));

      const result = await quarantineSidecarsForDirtyRecovery(dbPath, () => {});

      expect(result).toEqual({
        moved: [`${dbPath}.wal.dirty-recovery`],
        removed: [],
        failed: [],
      });
      // Fixed destination name caps accumulation at one parked file: the
      // newest crash's bytes win.
      expect(
        Buffer.compare(readFileSync(`${dbPath}.wal.dirty-recovery`), Buffer.alloc(2048, 0x11)),
      ).toBe(0);
      await expect(inspectLbugSidecars(dbPath)).resolves.toEqual({ kind: 'clean', dbPath });
    });

    it('rm-fallback: a persistently rename-locked .wal is REMOVED (bytes gone), .shadow still parks, log says forensics discarded (FIX 1)', async () => {
      await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(2048, 0x11));
      await fs.writeFile(`${dbPath}.shadow`, Buffer.alloc(1024, 0x22));
      // Path-filtered rename spy with a typed captured original (precedent:
      // repo-manager-transient-error.test.ts EACCES case, minus its as-any):
      // every rename whose SOURCE is the .wal sidecar fails EBUSY — the
      // retried direct park AND the confirm probe — simulating a holder that
      // blocks RENAME but not unlink (#2396's common deploy shape). fs.rm is
      // untouched, so the rm-fallback succeeds and the poisoned bytes are
      // gone: forensics lost, replay risk eliminated.
      const originalRename: typeof fs.rename = fs.rename;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(from).endsWith('.wal')) {
          const err = new Error('resource busy or locked') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        return originalRename(from, to);
      });
      const messages: string[] = [];

      const result = await quarantineSidecarsForDirtyRecovery(dbPath, (m) => messages.push(m));

      // Per-suffix isolation: the .wal escalation did not skip the .shadow park.
      expect(result).toEqual({
        moved: [`${dbPath}.shadow.dirty-recovery`],
        removed: [`${dbPath}.wal`],
        failed: [],
      });
      // The poisoned bytes are GONE — nothing for any subsequent open to replay.
      await expect(fs.stat(`${dbPath}.wal`)).rejects.toMatchObject({ code: 'ENOENT' });
      const joined = messages.join('\n');
      expect(joined).toContain('forensics');
      expect(joined).toContain('replay risk is eliminated');
    });

    it('all-fail (rename + probe + rm locked) lands in failed with honest guidance, and the previous parked copy survives untouched', async () => {
      const staleBytes = 'previous crash forensics';
      await fs.writeFile(`${dbPath}.wal.dirty-recovery`, staleBytes);
      await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(2048, 0x33));
      // Source locked for EVERY escape hatch: the retried direct park, the
      // `${to}.next` probe, AND the rm-fallback. The pre-tri-review shape
      // rm'd the stale parked copy BEFORE attempting the rename — destroying
      // the prior crash's forensics exactly here, where nothing ever
      // replaces them.
      const originalRename: typeof fs.rename = fs.rename;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(from).endsWith('.wal')) {
          const err = new Error('operation not permitted') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        return originalRename(from, to);
      });
      const originalRm: typeof fs.rm = fs.rm;
      vi.spyOn(fs, 'rm').mockImplementation(async (p, opts) => {
        if (String(p).endsWith('.wal')) {
          const err = new Error('resource busy or locked') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        return originalRm(p, opts);
      });
      const messages: string[] = [];

      const result = await quarantineSidecarsForDirtyRecovery(dbPath, (m) => messages.push(m));

      expect(result).toEqual({ moved: [], removed: [], failed: [`${dbPath}.wal`] });
      // The stale parked copy's bytes survived untouched…
      expect(readFileSync(`${dbPath}.wal.dirty-recovery`, 'utf-8')).toBe(staleBytes);
      // …and the locked source is still in place (nothing was half-moved).
      await expect(fs.stat(`${dbPath}.wal`)).resolves.toBeDefined();
      const joined = messages.join('\n');
      // Honest EBUSY/EPERM-class guidance: stop the holder, AV exclusion, re-run…
      expect(joined).toContain('stop any GitNexus MCP or serve process');
      expect(joined).toContain('antivirus exclusion');
      // …and NOT the old false promise — the pre-wipe open would replay the
      // poisoned WAL and die before any wipe could happen.
      expect(joined).not.toContain('wipe it in place');
    });

    it('replaces a stale parked copy via the probe-promote path on a true rename-onto-existing collision', async () => {
      await fs.writeFile(`${dbPath}.wal.dirty-recovery`, 'stale parked bytes');
      await fs.writeFile(`${dbPath}.wal`, Buffer.alloc(2048, 0x44));
      // Reject ONLY the direct `rename(from, to)` — Windows
      // rename-onto-existing semantics — while the collision-free `.next`
      // probe and its promotion succeed. Deterministic cross-platform pin of
      // the branch the "parks a lone WAL" case above only exercises
      // implicitly on Windows (POSIX rename overwrites in place). EEXIST is
      // outside the transient lock class, so the retry loop must fall
      // through to the probe on the FIRST failure, not burn the budget.
      const originalRename: typeof fs.rename = fs.rename;
      let directRenameAttempts = 0;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(from).endsWith('.wal') && String(to).endsWith('.dirty-recovery')) {
          directRenameAttempts += 1;
          const err = new Error('file already exists') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        return originalRename(from, to);
      });

      const result = await quarantineSidecarsForDirtyRecovery(dbPath, () => {});

      expect(result).toEqual({
        moved: [`${dbPath}.wal.dirty-recovery`],
        removed: [],
        failed: [],
      });
      expect(directRenameAttempts).toBe(1);
      // Newest forensics win — and no `.next` probe residue is left behind.
      expect(
        Buffer.compare(readFileSync(`${dbPath}.wal.dirty-recovery`), Buffer.alloc(2048, 0x44)),
      ).toBe(0);
      await expect(fs.stat(`${dbPath}.wal.dirty-recovery.next`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(inspectLbugSidecars(dbPath)).resolves.toEqual({ kind: 'clean', dbPath });
    });
  });

  describe('listParkedDirtyRecoverySidecars / cleanParkedDirtyRecoverySidecars (tri-review 4669518496 P2-7)', () => {
    it('returns [] and deletes nothing when no parked files exist', async () => {
      await expect(listParkedDirtyRecoverySidecars(dbPath)).resolves.toEqual([]);
      await expect(cleanParkedDirtyRecoverySidecars(dbPath)).resolves.toEqual([]);
    });

    it('lists exactly the single present parked file', async () => {
      await fs.writeFile(`${dbPath}.wal.dirty-recovery`, 'parked wal bytes');

      await expect(listParkedDirtyRecoverySidecars(dbPath)).resolves.toEqual([
        `${dbPath}.wal.dirty-recovery`,
      ]);
    });

    it('lists parked files AND .next residue sorted; live sidecars and missing-shadow quarantines are not enumerated', async () => {
      await fs.writeFile(`${dbPath}.wal.dirty-recovery`, 'parked wal bytes');
      await fs.writeFile(`${dbPath}.shadow.dirty-recovery`, 'parked shadow bytes');
      // Fixed-name lister must not sweep up neighbors — a LIVE wal and a
      // missing-shadow quarantine (the OTHER family) — while the
      // double-failure `.next` residue IS enumerated since FIX 5 of this
      // shipping review (it used to be invisible to every surface while the
      // docs said "remove manually").
      await fs.writeFile(`${dbPath}.wal`, 'live wal');
      await fs.writeFile(`${dbPath}.wal.missing-shadow.1-a`, '');
      await fs.writeFile(`${dbPath}.wal.dirty-recovery.next`, 'residue');

      await expect(listParkedDirtyRecoverySidecars(dbPath)).resolves.toEqual([
        `${dbPath}.shadow.dirty-recovery`,
        `${dbPath}.wal.dirty-recovery`,
        `${dbPath}.wal.dirty-recovery.next`,
      ]);
    });

    it('clean removes the parked files (.next residue included), returns their paths, and leaves the missing-shadow family alone', async () => {
      await fs.writeFile(`${dbPath}.wal.dirty-recovery`, 'parked wal bytes');
      await fs.writeFile(`${dbPath}.shadow.dirty-recovery`, 'parked shadow bytes');
      await fs.writeFile(`${dbPath}.wal.dirty-recovery.next`, 'residue');
      await fs.writeFile(`${dbPath}.wal.missing-shadow.1-a`, '');

      await expect(cleanParkedDirtyRecoverySidecars(dbPath)).resolves.toEqual([
        `${dbPath}.shadow.dirty-recovery`,
        `${dbPath}.wal.dirty-recovery`,
        `${dbPath}.wal.dirty-recovery.next`,
      ]);

      await expect(fs.stat(`${dbPath}.wal.dirty-recovery`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.stat(`${dbPath}.shadow.dirty-recovery`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.stat(`${dbPath}.wal.dirty-recovery.next`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // The other family is untouched by the new pair…
      await expect(listQuarantinedMissingShadowWals(dbPath)).resolves.toEqual([
        `${dbPath}.wal.missing-shadow.1-a`,
      ]);
      // …and a second clean is an idempotent no-op.
      await expect(cleanParkedDirtyRecoverySidecars(dbPath)).resolves.toEqual([]);
    });

    it('missing-shadow cleaner leaves dirty-recovery parks untouched (vice-versa isolation)', async () => {
      await fs.writeFile(`${dbPath}.wal.dirty-recovery`, 'parked wal bytes');
      await fs.writeFile(`${dbPath}.wal.missing-shadow.1-a`, '');

      await expect(cleanQuarantinedMissingShadowWals(dbPath)).resolves.toEqual([
        `${dbPath}.wal.missing-shadow.1-a`,
      ]);
      await expect(listParkedDirtyRecoverySidecars(dbPath)).resolves.toEqual([
        `${dbPath}.wal.dirty-recovery`,
      ]);
    });
  });

  describe('listParkedLbugSidecars / cleanParkedLbugSidecars aggregate (this shipping review, FIX 5)', () => {
    it('aggregates both families — missing-shadow quarantines plus dirty-recovery parks and .next residue', async () => {
      await fs.writeFile(`${dbPath}.wal.missing-shadow.1-a`, '');
      await fs.writeFile(`${dbPath}.wal.missing-shadow.2-b`, '');
      await fs.writeFile(`${dbPath}.wal.dirty-recovery`, 'parked wal bytes');
      await fs.writeFile(`${dbPath}.shadow.dirty-recovery.next`, 'residue');

      await expect(listParkedLbugSidecars(dbPath)).resolves.toEqual([
        `${dbPath}.wal.missing-shadow.1-a`,
        `${dbPath}.wal.missing-shadow.2-b`,
        `${dbPath}.shadow.dirty-recovery.next`,
        `${dbPath}.wal.dirty-recovery`,
      ]);

      const result = await cleanParkedLbugSidecars(dbPath);
      expect(result).toEqual({
        deleted: [
          `${dbPath}.wal.missing-shadow.1-a`,
          `${dbPath}.wal.missing-shadow.2-b`,
          `${dbPath}.shadow.dirty-recovery.next`,
          `${dbPath}.wal.dirty-recovery`,
        ],
        failed: [],
      });
      await expect(listParkedLbugSidecars(dbPath)).resolves.toEqual([]);
    });

    it('a locked parked file lands in failed while every other file is still deleted (no throw, no partial abort)', async () => {
      await fs.writeFile(`${dbPath}.wal.missing-shadow.1-a`, '');
      await fs.writeFile(`${dbPath}.wal.dirty-recovery`, 'parked wal bytes');
      await fs.writeFile(`${dbPath}.shadow.dirty-recovery`, 'parked shadow bytes');
      // One EBUSY-locked file mid-roster: the old per-family cleaners threw
      // on it, crashing the whole clean after a partial deletion. Typed
      // captured original, path-filtered.
      const originalUnlink: typeof fs.unlink = fs.unlink;
      vi.spyOn(fs, 'unlink').mockImplementation(async (p) => {
        if (String(p) === `${dbPath}.wal.dirty-recovery`) {
          const err = new Error('resource busy or locked') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        return originalUnlink(p);
      });

      const result = await cleanParkedLbugSidecars(dbPath);

      expect(result).toEqual({
        deleted: [`${dbPath}.wal.missing-shadow.1-a`, `${dbPath}.shadow.dirty-recovery`],
        failed: [`${dbPath}.wal.dirty-recovery`],
      });
      // The locked file is still on disk; everything else is gone.
      await expect(fs.stat(`${dbPath}.wal.dirty-recovery`)).resolves.toBeDefined();
      await expect(fs.stat(`${dbPath}.wal.missing-shadow.1-a`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.stat(`${dbPath}.shadow.dirty-recovery`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('a list→delete race (ENOENT at unlink time) is skipped silently — neither deleted nor failed', async () => {
      await fs.writeFile(`${dbPath}.wal.dirty-recovery`, 'parked wal bytes');
      await fs.writeFile(`${dbPath}.shadow.dirty-recovery`, 'parked shadow bytes');
      const originalUnlink: typeof fs.unlink = fs.unlink;
      vi.spyOn(fs, 'unlink').mockImplementation(async (p) => {
        if (String(p) === `${dbPath}.wal.dirty-recovery`) {
          // Simulate another process winning the race after the list.
          await originalUnlink(p);
        }
        return originalUnlink(p);
      });

      const result = await cleanParkedLbugSidecars(dbPath);

      expect(result).toEqual({
        deleted: [`${dbPath}.shadow.dirty-recovery`],
        failed: [],
      });
      await expect(listParkedLbugSidecars(dbPath)).resolves.toEqual([]);
    });
  });
});
