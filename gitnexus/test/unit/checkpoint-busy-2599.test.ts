/**
 * #2599: a WAL-checkpoint IO error that also carries a busy/lock signal means
 * another handle holds the store open (a `gitnexus mcp` server, or this
 * process's own reader) — not a disk fault. `isLbugCheckpointBusyError`
 * classifies it; the CLI (analyze.ts) names that held-open cause alongside the
 * existing --wal-checkpoint-threshold recovery hint, leaving the original IO
 * error intact.
 */
import { describe, it, expect } from 'vitest';
import { isLbugCheckpointBusyError } from '../../src/core/lbug/lbug-config.js';

const IO_BUSY =
  'runtime exception: io exception: error renaming file /x/lbug.wal to /x/lbug.wal.checkpoint: could not set lock on file';
const IO_DISK =
  'runtime exception: io exception: error removing directory or file /x/lbug.wal.checkpoint: disk full';

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

  it('ignores nullish input', () => {
    expect(isLbugCheckpointBusyError(undefined)).toBe(false);
    expect(isLbugCheckpointBusyError(null)).toBe(false);
  });
});
