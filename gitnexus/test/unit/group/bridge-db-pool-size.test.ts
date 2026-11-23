import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupTempDir } from '../../helpers/test-db.js';
import {
  closeBridgeDb,
  openBridgeDb,
  openBridgeDbReadOnly,
  queryBridge,
  writeBridge,
} from '../../../src/core/group/bridge-db.js';
import { _setOsPageSizeForTests } from '../../../src/core/lbug/lbug-config.js';
import { QUERY_MAX_RSS_ENV } from '../../../src/core/lbug/query-memory-guard.js';
import type { BridgeHandle } from '../../../src/core/group/types.js';

// Group sync writes the bridge through a writable open, which is outside the
// read query memory guard; group tools read it through a read-only open. The
// real engine reports the pool it was given (`CALL bm_info()`), so this checks
// the wiring end to end, not just the sizing arithmetic.

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const poolLimit = async (handle: BridgeHandle): Promise<number> => {
  const rows = await queryBridge<{ mem_limit: number | bigint }>(handle, 'CALL bm_info() RETURN *');
  return Number(rows[0].mem_limit);
};

describe('bridge database pool size in a 1 GiB container', () => {
  let tmpDir: string;
  let restoreConstrained: () => void;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-pool-size-'));
    _setOsPageSizeForTests(4096);
    vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', undefined);
    vi.stubEnv(QUERY_MAX_RSS_ENV, '512');
    vi.spyOn(os, 'totalmem').mockReturnValue(64 * GiB);
    const desc = Object.getOwnPropertyDescriptor(process, 'constrainedMemory');
    Object.defineProperty(process, 'constrainedMemory', { configurable: true, value: () => GiB });
    restoreConstrained = () => {
      if (desc) Object.defineProperty(process, 'constrainedMemory', desc);
      else delete (process as { constrainedMemory?: unknown }).constrainedMemory;
    };
  });

  afterEach(async () => {
    restoreConstrained();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    _setOsPageSizeForTests(undefined);
    await cleanupTempDir(tmpDir);
  });

  it('a bridge write gets 80% of the container whatever the query budget', async () => {
    const handle = await openBridgeDb(path.join(tmpDir, 'bridge.lbug'));
    try {
      expect(await poolLimit(handle)).toBe(Math.floor(0.8 * GiB));
    } finally {
      await closeBridgeDb(handle);
    }
  });

  it('a bridge read gets the reader pool under the query budget', async () => {
    await writeBridge(tmpDir, {
      contracts: [],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: [],
    });
    const handle = await openBridgeDbReadOnly(tmpDir);
    if (!handle) throw new Error('expected a readable bridge');
    try {
      // GITNEXUS_QUERY_MAX_RSS_MB=512: budget 512 MiB minus 256 MiB headroom.
      expect(await poolLimit(handle)).toBe(256 * MiB);
    } finally {
      await closeBridgeDb(handle);
    }
  });
});
