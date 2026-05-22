/**
 * Unit tests for the manual WAL checkpoint driver (#1741 follow-up).
 *
 * The driver wraps a CHECKPOINT call in a bounded retry that fires only
 * on `isLbugCheckpointIoError` shapes. These tests inject a fake
 * `checkpointFn`, fake `sleepFn`, and fake `randomFn` to exercise the
 * retry policy deterministically without touching a real LadybugDB.
 *
 * Integration-level coverage that the driver actually runs against a
 * native engine lives in `test/integration/analyze-wal-checkpoint-failure.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isManualCheckpointEnabled,
  runCheckpointWithRetry,
  startWalCheckpointDriver,
} from '../../src/core/lbug/wal-checkpoint-driver.js';

const makeCheckpointError = () =>
  // Matches the strict rename matcher in lbug-config.ts.
  new Error(
    'Runtime exception: IO exception: Error renaming file /tmp/lbug.wal to /tmp/lbug.wal.checkpoint. ErrorMessage: Permission denied',
  );

describe('runCheckpointWithRetry — retry policy', () => {
  it('returns on first success with attempts=1 and no sleeps', async () => {
    const checkpointFn = vi.fn().mockResolvedValue(true);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const randomFn = vi.fn().mockReturnValue(0);

    const result = await runCheckpointWithRetry({ checkpointFn, sleepFn, randomFn });

    expect(result.attempts).toBe(1);
    expect(result.flushed).toBe(true);
    expect(checkpointFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledTimes(0);
  });

  it('retries up to 3 times on checkpoint IO errors and succeeds on the final attempt', async () => {
    const checkpointFn = vi
      .fn()
      .mockRejectedValueOnce(makeCheckpointError())
      .mockRejectedValueOnce(makeCheckpointError())
      .mockResolvedValueOnce(true);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    // Fixed random returns 0, so jitter contributes 0 ms and we can
    // assert exact delays against BASE_DELAYS_MS = [50, 200, 500].
    const randomFn = vi.fn().mockReturnValue(0);

    const result = await runCheckpointWithRetry({ checkpointFn, sleepFn, randomFn });

    expect(result.attempts).toBe(3);
    expect(result.flushed).toBe(true);
    expect(checkpointFn).toHaveBeenCalledTimes(3);
    // Sleeps happen between attempts: after attempt 1 (50 ms) and after
    // attempt 2 (200 ms). No sleep after the final attempt.
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 50);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 200);
  });

  it('rethrows the last error after exhausting all retries on persistent IO failures', async () => {
    const persistent = makeCheckpointError();
    const checkpointFn = vi.fn().mockRejectedValue(persistent);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const randomFn = vi.fn().mockReturnValue(0);

    await expect(runCheckpointWithRetry({ checkpointFn, sleepFn, randomFn })).rejects.toBe(
      persistent,
    );

    expect(checkpointFn).toHaveBeenCalledTimes(3);
    // Two backoffs (50 ms, 200 ms) but no sleep after the final attempt.
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 50);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 200);
  });

  it('does NOT retry non-checkpoint errors (e.g. WAL corruption surfaces immediately)', async () => {
    const corruption = new Error('Runtime exception: Corrupted wal file.');
    const checkpointFn = vi.fn().mockRejectedValue(corruption);
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    await expect(runCheckpointWithRetry({ checkpointFn, sleepFn })).rejects.toBe(corruption);

    expect(checkpointFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledTimes(0);
  });

  it('jitter is bounded: 0 <= jitter < 50 ms regardless of random source', async () => {
    const checkpointFn = vi
      .fn()
      .mockRejectedValueOnce(makeCheckpointError())
      .mockResolvedValueOnce(true);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    // Random returns 0.999... — jitter should still be <50 ms (floor).
    const randomFn = vi.fn().mockReturnValue(0.9999);

    await runCheckpointWithRetry({ checkpointFn, sleepFn, randomFn });

    expect(sleepFn).toHaveBeenCalledTimes(1);
    const delay = sleepFn.mock.calls[0][0] as number;
    expect(delay).toBe(50 + Math.floor(0.9999 * 50)); // == 99
  });
});

describe('isManualCheckpointEnabled — env var parsing', () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT;
    else process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT = originalEnv;
  });

  it('defaults to enabled when the env var is unset', () => {
    delete process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT;
    expect(isManualCheckpointEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'FALSE', 'off', 'no', ' 0 '])(
    'returns false for opt-out value %s',
    (value) => {
      process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT = value;
      expect(isManualCheckpointEnabled()).toBe(false);
    },
  );

  it.each(['1', 'true', 'on', 'yes', ''])('returns true for non-opt-out value %s', (value) => {
    process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT = value;
    expect(isManualCheckpointEnabled()).toBe(true);
  });
});

describe('startWalCheckpointDriver — lifecycle', () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT;
    else process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT = originalEnv;
  });

  it('returns a no-op handle when manual checkpoint is disabled', async () => {
    process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT = '0';
    const driver = startWalCheckpointDriver({ periodMs: 10 });
    // stop() must resolve cleanly even when no interval was scheduled.
    await expect(driver.stop()).resolves.toBeUndefined();
  });

  it('stop() is idempotent (second call resolves without throwing)', async () => {
    process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT = '0';
    const driver = startWalCheckpointDriver({ periodMs: 10 });
    await driver.stop();
    await expect(driver.stop()).resolves.toBeUndefined();
  });
});
