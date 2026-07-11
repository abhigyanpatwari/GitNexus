/**
 * Unit tests for `wipeLbugDbFiles` / `LbugWipeError` (#2409, tri-review
 * 4669518496 P2-4 / KTD4).
 *
 * The helper owns the canonical 4-file LadybugDB family list and the
 * ENOENT-verified removal contract: a path counts as gone only when the
 * post-rm probe rejects with ENOENT; a resolving probe or an
 * EPERM/EBUSY/EACCES rejection (the Windows delete-pending / handle-lag
 * class) is a survivor that must surface as a typed, self-contained error
 * after the bounded retry budget — never a silent skip that lets initLbug
 * reopen a still-populated DB. Pure fs — no LadybugDB database is opened.
 *
 * fs spies are path-filtered with TYPED captured originals
 * (repo-manager-transient-error.test.ts precedent, minus its `as any`).
 */
import fs from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LbugWipeError, wipeLbugDbFiles } from '../../src/core/lbug/lbug-adapter.js';
import { _captureLogger } from '../../src/core/logger.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

const familyOf = (lbugPath: string): string[] => [
  lbugPath,
  `${lbugPath}.wal`,
  `${lbugPath}.shadow`,
  `${lbugPath}.lock`,
];

const createFamily = async (lbugPath: string): Promise<void> => {
  for (const f of familyOf(lbugPath)) {
    await fs.writeFile(f, 'fixture-bytes');
  }
};

const errnoError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: injected by lbug-wipe-db-files.test.ts`), { code });

describe('wipeLbugDbFiles (#2409 loud ENOENT-verified wipe)', () => {
  let tmp: TestDBHandle | undefined;

  afterEach(async () => {
    // Restore fs spies BEFORE the temp-dir cleanup so cleanup's own fs.rm
    // never routes through a rejecting mock.
    vi.restoreAllMocks();
    await tmp?.cleanup();
    tmp = undefined;
  });

  it('removes the whole 4-file family and resolves (happy path)', async () => {
    tmp = await createTempDir('gitnexus-test-wipe-');
    const lbugPath = path.join(tmp.dbPath, 'lbug');
    await createFamily(lbugPath);

    await expect(wipeLbugDbFiles(lbugPath)).resolves.toBeUndefined();

    for (const f of familyOf(lbugPath)) {
      await expect(fs.access(f)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('is a no-op when none of the family exists', async () => {
    tmp = await createTempDir('gitnexus-test-wipe-');
    const lbugPath = path.join(tmp.dbPath, 'lbug');

    await expect(wipeLbugDbFiles(lbugPath)).resolves.toBeUndefined();
  });

  it('throws a typed LbugWipeError naming the path when fs.rm keeps rejecting', async () => {
    tmp = await createTempDir('gitnexus-test-wipe-');
    const lbugPath = path.join(tmp.dbPath, 'lbug');
    const walPath = `${lbugPath}.wal`;
    await createFamily(lbugPath);

    // Path-filtered spy: only the `.wal` rm fails; the rest of the family
    // passes through to the real implementation.
    const originalRm: typeof fs.rm = fs.rm;
    vi.spyOn(fs, 'rm').mockImplementation(async (p, options) => {
      if (String(p) === walPath) throw errnoError('EPERM');
      return originalRm(p, options);
    });

    const rejection: unknown = await wipeLbugDbFiles(lbugPath).then(
      () => null,
      (e: unknown) => e,
    );

    expect(rejection).toBeInstanceOf(LbugWipeError);
    expect(rejection).toMatchObject({
      name: 'LbugWipeError',
      survivors: [walPath],
      // Self-contained message: survivor path + remediation, because the
      // serve worker forwards ONLY err.message over IPC.
      message: expect.stringContaining(walPath),
    });
    expect(rejection).toMatchObject({
      // Shared lock-remediation copy (this shipping review, FIX 7) plus the
      // own-handle framing (FIX 2): the holder may be this very process's
      // just-closed DB or an AV scan, so an immediate re-run often succeeds.
      message: expect.stringMatching(/stop any GitNexus MCP or serve process/i),
    });
    expect(rejection).toMatchObject({
      message: expect.stringMatching(/an immediate re-run often succeeds/i),
    });

    // Per-path isolation: the survivor did not abort the rest of the family.
    for (const f of [lbugPath, `${lbugPath}.shadow`, `${lbugPath}.lock`]) {
      await expect(fs.access(f)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('treats a persistent EPERM probe as a survivor even when rm resolves (delete-pending class)', async () => {
    tmp = await createTempDir('gitnexus-test-wipe-');
    const lbugPath = path.join(tmp.dbPath, 'lbug');
    await createFamily(lbugPath);

    // rm resolves (the real files ARE unlinked) but the main DB file's probe
    // keeps rejecting EPERM — the Windows delete-pending signature: the name
    // stays visible while another process holds the last handle. Gone must
    // mean ENOENT specifically, so this DATA-BEARING path must be reported,
    // not assumed gone. (Retargeted from `.lock` — since FIX 2 of this
    // shipping review the contentless lock file is tolerated, see below.)
    const originalAccess: typeof fs.access = fs.access;
    vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
      if (String(p) === lbugPath) throw errnoError('EPERM');
      return originalAccess(p, mode);
    });

    const rejection: unknown = await wipeLbugDbFiles(lbugPath).then(
      () => null,
      (e: unknown) => e,
    );

    expect(rejection).toBeInstanceOf(LbugWipeError);
    expect(rejection).toMatchObject({ survivors: [lbugPath] });
  });

  it('a persistent survivor on ONLY the contentless .lock warns and resolves — no throw (FIX 2)', async () => {
    tmp = await createTempDir('gitnexus-test-wipe-');
    const lbugPath = path.join(tmp.dbPath, 'lbug');
    const lockPath = `${lbugPath}.lock`;
    await createFamily(lbugPath);

    // The `.lock` rm keeps failing EPERM (an AV-held delete-pending handle
    // outlasting the retry budget). The lock file is contentless — initLbug
    // recreates it, and a genuinely held lock surfaces as the reopen's own
    // lock-busy classification — so failing a sound rebuild over it was
    // pure collateral (FIX 2, finder B).
    const originalRm: typeof fs.rm = fs.rm;
    vi.spyOn(fs, 'rm').mockImplementation(async (p, options) => {
      if (String(p) === lockPath) throw errnoError('EPERM');
      return originalRm(p, options);
    });
    const cap = _captureLogger();
    try {
      await expect(wipeLbugDbFiles(lbugPath)).resolves.toBeUndefined();

      // The data-bearing members are really gone…
      for (const f of [lbugPath, `${lbugPath}.wal`, `${lbugPath}.shadow`]) {
        await expect(fs.access(f)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      // …the lock file remains (the injected failure)…
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
      // …and the tolerance was logged at warn level, not silent.
      const warned = cap
        .records()
        .find((r) => typeof r.msg === 'string' && r.msg.includes(lockPath));
      expect(warned).toBeDefined();
      expect(warned).toMatchObject({ msg: expect.stringContaining('lock-busy') });
    } finally {
      cap.restore();
    }
  });
});
