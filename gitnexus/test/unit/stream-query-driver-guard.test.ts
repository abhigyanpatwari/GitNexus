/**
 * Unit tests for the streamQuery WAL-driver guard (#2264). streamQuery is
 * deliberately NOT wrapped in withConnLock (its per-row callback re-enters the
 * adapter), so it must refuse to run while the WAL-checkpoint driver is live —
 * otherwise its unlocked per-row reads could race a CHECKPOINT on the shared
 * connection (the corruption window the lock serializes everything else against).
 * Today the serve/read path never starts the driver; this guard fails loud if a
 * future in-process analyze ever overlaps a stream.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { streamQuery } from '../../src/core/lbug/lbug-adapter.js';
import { markWalDriverActive } from '../../src/core/lbug/wal-driver-state.js';
import { startWalCheckpointDriver } from '../../src/core/lbug/wal-checkpoint-driver.js';

describe('streamQuery WAL-driver guard (#2264)', () => {
  beforeEach(() => {
    // Manual checkpoint defaults on; pin it so the driver path is deterministic.
    vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '1');
  });

  afterEach(() => {
    markWalDriverActive(false);
    vi.unstubAllEnvs();
  });

  it('throws when the WAL-checkpoint driver is active', async () => {
    markWalDriverActive(true);
    await expect(streamQuery('RETURN 1 AS one', () => undefined)).rejects.toThrow(
      /WAL-checkpoint driver is active/,
    );
  });

  it('passes the guard when inactive (reaching the not-initialized check)', async () => {
    markWalDriverActive(false);
    await expect(streamQuery('RETURN 1 AS one', () => undefined)).rejects.toThrow(
      /not initialized/,
    );
  });

  it('startWalCheckpointDriver arms the guard; stop() disarms it', async () => {
    const driver = startWalCheckpointDriver({ periodMs: 1_000_000 });
    try {
      await expect(streamQuery('RETURN 1 AS one', () => undefined)).rejects.toThrow(
        /WAL-checkpoint driver is active/,
      );
    } finally {
      await driver.stop();
    }
    await expect(streamQuery('RETURN 1 AS one', () => undefined)).rejects.toThrow(
      /not initialized/,
    );
  });
});
