/**
 * #2599: a WAL-checkpoint IO error that also carries a busy/lock signal means
 * another handle holds the store open (a `gitnexus mcp` server, or this
 * process's own reader) — not a disk fault. `isLbugCheckpointBusyError`
 * classifies it, and the checkpoint driver names that held-open cause when it
 * exhausts its retry budget on such an error.
 */
import { describe, it, expect } from 'vitest';
import { isLbugCheckpointBusyError } from '../../src/core/lbug/lbug-config.js';
import { runCheckpointWithRetry } from '../../src/core/lbug/wal-checkpoint-driver.js';

const IO_BUSY =
  'runtime exception: io exception: error renaming file /x/lbug.wal to /x/lbug.wal.checkpoint: could not set lock on file';
const IO_DISK =
  'runtime exception: io exception: error removing directory or file /x/lbug.wal.checkpoint: disk full';
const fast = { sleepFn: async () => {}, randomFn: () => 0 };

describe('#2599 checkpoint-busy classification', () => {
  it('classifies a checkpoint IO error carrying a lock signal as busy', () => {
    expect(isLbugCheckpointBusyError(new Error(IO_BUSY))).toBe(true);
  });

  it('does not classify a plain checkpoint IO error (disk fault) as busy', () => {
    expect(isLbugCheckpointBusyError(new Error(IO_DISK))).toBe(false);
  });

  it('does not classify a non-checkpoint lock error as checkpoint-busy', () => {
    expect(isLbugCheckpointBusyError(new Error('could not set lock on file /x/lbug'))).toBe(false);
  });

  it('names the held-open cause when a busy checkpoint exhausts retries', async () => {
    await expect(
      runCheckpointWithRetry({
        ...fast,
        checkpointFn: async () => {
          throw new Error(IO_BUSY);
        },
      }),
    ).rejects.toThrow(/another process holds the store open/);
  });

  it('surfaces a plain disk IO error without the held-open hint', async () => {
    const run = () =>
      runCheckpointWithRetry({
        ...fast,
        checkpointFn: async () => {
          throw new Error(IO_DISK);
        },
      });
    await expect(run()).rejects.toThrow(/disk full/);
    await expect(run()).rejects.not.toThrow(/another process/);
  });
});
