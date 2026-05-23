/**
 * Unit tests for the Windows FTS probe in pool-adapter.ts.
 *
 * Covers `hasLocalWinFtsExtension()` — the helper that gates the
 * Windows-only skip of `loadFTSExtension` in `doInitLbug` and
 * `initLbugWithDb`. Issue #1690 / PR #1692.
 *
 * The probe is exercised against a real temp filesystem with
 * `os.homedir()` spied to point at the tempdir. This tests the
 * actual fs surface (readdir/stat semantics, missing-dir behavior,
 * zero-byte file handling) rather than mocking fs internals.
 *
 * The Windows-branch conditional in `doInitLbug` / `initLbugWithDb`
 * is intentionally not unit-tested in isolation: those functions
 * require a fully constructed `lbug.Database` + `Connection` pool
 * and are exercised end-to-end by `test/integration/lbug-pool*.test.ts`
 * on the `windows-latest` matrix. The conditional itself is a single
 * expression — `(await hasLocalWinFtsExtension()) ? load : true` —
 * whose correctness reduces to the probe being correctly tested here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

// Stub out the LadybugDB native loader and its transitive importers so that
// importing pool-adapter.ts in this unit test does not pull in the .node binary
// (which is built by the postinstall script and is not always present in the
// dev install used for unit tests).
vi.mock('@ladybugdb/core', () => ({
  default: { Database: vi.fn(), Connection: vi.fn() },
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  isReadOnlyDbError: vi.fn(() => false),
  loadFTSExtension: vi.fn(),
}));
vi.mock('../../src/core/lbug/lbug-config.js', () => ({
  createLbugDatabase: vi.fn(),
  isWalCorruptionError: vi.fn(() => false),
  WAL_RECOVERY_SUGGESTION: '',
}));

import { hasLocalWinFtsExtension } from '../../src/core/lbug/pool-adapter.js';

describe('hasLocalWinFtsExtension', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-fts-probe-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('returns false when ~/.lbdb/extension does not exist', async () => {
    // tmpHome is empty; the probe should swallow the readdir ENOENT and return false.
    await expect(hasLocalWinFtsExtension()).resolves.toBe(false);
  });

  it('returns false when ~/.lbdb/extension exists but has no version dirs', async () => {
    await fs.mkdir(path.join(tmpHome, '.lbdb', 'extension'), { recursive: true });
    await expect(hasLocalWinFtsExtension()).resolves.toBe(false);
  });

  it('returns true when a single version dir contains the FTS binary', async () => {
    const ftsDir = path.join(tmpHome, '.lbdb', 'extension', '0.16.0', 'win_amd64', 'fts');
    await fs.mkdir(ftsDir, { recursive: true });
    await fs.writeFile(path.join(ftsDir, 'libfts.lbug_extension'), Buffer.from('mock-binary'));
    await expect(hasLocalWinFtsExtension()).resolves.toBe(true);
  });

  it('returns true when the binary is a zero-byte stub (LOAD failure handled downstream)', async () => {
    // Empirically verified in #1690 thread: LadybugDB resolves LOAD EXTENSION fts to a
    // version-specific path internally and the ExtensionManager's tryLoad try/catch
    // catches the resulting load error cleanly. Probe is intentionally generous here;
    // safety lives in the loader, not the probe.
    const ftsDir = path.join(tmpHome, '.lbdb', 'extension', '0.16.0', 'win_amd64', 'fts');
    await fs.mkdir(ftsDir, { recursive: true });
    await fs.writeFile(path.join(ftsDir, 'libfts.lbug_extension'), '');
    await expect(hasLocalWinFtsExtension()).resolves.toBe(true);
  });

  it('returns true when multiple version dirs exist and only one carries the binary', async () => {
    const versions = ['0.15.0', '0.16.0', '0.17.0'];
    for (const v of versions) {
      await fs.mkdir(path.join(tmpHome, '.lbdb', 'extension', v, 'win_amd64', 'fts'), {
        recursive: true,
      });
    }
    // Only 0.16.0 has the binary; the probe should keep iterating past empty siblings.
    await fs.writeFile(
      path.join(
        tmpHome,
        '.lbdb',
        'extension',
        '0.16.0',
        'win_amd64',
        'fts',
        'libfts.lbug_extension',
      ),
      Buffer.from('mock-binary'),
    );
    await expect(hasLocalWinFtsExtension()).resolves.toBe(true);
  });

  it('returns false when version dirs exist but none contain the binary', async () => {
    // Adversarial topology raised by #1690 review: tree exists (Nix store, Bazel
    // sandbox seeding, corporate MDM-prepopulated user dirs) but the actual
    // libfts.lbug_extension file is absent. Probe must distinguish file from dir.
    const versions = ['0.15.0', '0.16.0', '0.17.0'];
    for (const v of versions) {
      await fs.mkdir(path.join(tmpHome, '.lbdb', 'extension', v, 'win_amd64', 'fts'), {
        recursive: true,
      });
    }
    await expect(hasLocalWinFtsExtension()).resolves.toBe(false);
  });

  it('returns false when fs.readdir throws (e.g. permission denied on the extension root)', async () => {
    // Cover the outer try/catch — any fs error walking the extension root is
    // treated as "no binary present", matching the upstream skip-guard intent.
    const eaccess = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    }) as NodeJS.ErrnoException;
    vi.spyOn(fs, 'readdir').mockRejectedValue(eaccess);
    await expect(hasLocalWinFtsExtension()).resolves.toBe(false);
  });
});
