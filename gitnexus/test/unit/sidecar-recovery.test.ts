import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _resetSidecarRecoveryWarningsForTest,
  finalizeLbugSidecarsAfterClose,
  inspectLbugSidecars,
  listQuarantinedMissingShadowWals,
  preflightLbugSidecars,
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
});
