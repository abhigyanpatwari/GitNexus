/**
 * collectFailureEvidence (#3530): the lines an analyze failure logs so a
 * maintainer can tell a truncated main file from pages pending in the staging
 * sidecars from GitNexus's own checkpoint running around the failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CheckpointActivity } from '../../src/core/lbug/wal-checkpoint-driver.js';
import { FILE_EVIDENCE_TIMEOUT_MS } from '../../src/core/lbug/sidecar-recovery.js';
import { createTempDir } from '../helpers/test-db.js';

const mocks = vi.hoisted(() => ({ readActivity: vi.fn<() => CheckpointActivity>() }));

vi.mock('../../src/core/lbug/wal-checkpoint-driver.js', () => ({
  readCheckpointActivity: mocks.readActivity,
}));

import { collectFailureEvidence } from '../../src/core/lbug/failure-evidence.js';

const NOW = 1_700_000_000_000;
const NO_ACTIVITY: CheckpointActivity = { completed: 0, lastCompletedAt: null, inFlight: 0 };
const STAGED_FILE_LABELS = [
  'live index',
  'staging copy',
  'staging copy .wal',
  'staging copy .shadow',
  'staging copy .wal.checkpoint',
];
const labelOf = (line: string): string => line.slice(0, line.indexOf(':'));

describe('collectFailureEvidence (#3530)', () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let live: string;
  let staging: string;

  beforeEach(async () => {
    temp = await createTempDir();
    live = path.join(temp.dbPath, 'lbug');
    staging = path.join(temp.dbPath, 'lbug.staging');
    mocks.readActivity.mockReset().mockReturnValue(NO_ACTIVITY);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await temp.cleanup();
  });

  it('reports only the live index and checkpoints for an in-place build', async () => {
    await fs.writeFile(live, 'hello');

    const lines = await collectFailureEvidence({ liveIndex: live }, NO_ACTIVITY);

    expect(lines.map(labelOf)).toEqual(['live index', 'checkpoints']);
    expect(lines[0]).toMatch(/^live index: apparent 5 B, /);
  });

  it('reports the staging copy and each of its sidecars, absent ones included', async () => {
    await fs.writeFile(live, 'hello');
    await fs.writeFile(staging, 'staged!!');
    await fs.writeFile(`${staging}.wal`, 'wal');

    const lines = await collectFailureEvidence(
      { liveIndex: live, stagingCopy: staging },
      NO_ACTIVITY,
    );

    expect(lines.map(labelOf)).toEqual([...STAGED_FILE_LABELS, 'checkpoints']);
    expect(lines[1]).toMatch(/^staging copy: apparent 8 B, /);
    expect(lines[2]).toMatch(/^staging copy \.wal: apparent 3 B, /);
    expect(lines[3]).toBe('staging copy .shadow: absent');
    expect(lines[4]).toBe('staging copy .wal.checkpoint: absent');
  });

  it.each([
    [
      'completed checkpoints and the time since the last',
      { completed: 3, lastCompletedAt: NOW - 1200, inFlight: 0 },
      'checkpoints: 3 completed, last 1200 ms before failure, 0 in flight',
    ],
    [
      'no completed checkpoint and one in flight',
      { completed: 0, lastCompletedAt: null, inFlight: 1 },
      'checkpoints: none completed, 1 in flight',
    ],
    [
      'a completion stamped after the failure (clock step)',
      { completed: 1, lastCompletedAt: NOW + 50, inFlight: 0 },
      'checkpoints: 1 completed, last 0 ms before failure, 0 in flight',
    ],
  ])('formats %s', async (_name, activity, expected) => {
    mocks.readActivity.mockReturnValue(activity);

    const lines = await collectFailureEvidence({ liveIndex: live }, NO_ACTIVITY);

    expect(lines.at(-1)).toBe(expected);
  });

  it.each([
    [
      'only checkpoints completed since the run began',
      { completed: 12, lastCompletedAt: NOW - 300, inFlight: 0 },
      'checkpoints: 2 completed, last 300 ms before failure, 0 in flight',
    ],
    [
      'none when every completion predates the run (an earlier watch refresh)',
      { completed: 10, lastCompletedAt: NOW - 100, inFlight: 0 },
      'checkpoints: none completed, 0 in flight',
    ],
  ])('counts %s', async (_name, activity, expected) => {
    mocks.readActivity.mockReturnValue(activity);
    const runStart: CheckpointActivity = { completed: 10, lastCompletedAt: NOW - 100, inFlight: 0 };

    const lines = await collectFailureEvidence({ liveIndex: live }, runStart);

    expect(lines.at(-1)).toBe(expected);
  });

  it('takes the checkpoint snapshot and dispatches every stat before its first await', async () => {
    const stat = vi.spyOn(fs, 'stat').mockReturnValue(new Promise<never>(() => {}));
    const statfs = vi.spyOn(fs, 'statfs').mockReturnValue(new Promise<never>(() => {}));
    const paths = [
      live,
      staging,
      `${staging}.wal`,
      `${staging}.shadow`,
      `${staging}.wal.checkpoint`,
    ];

    // Deliberately not awaited: everything asserted here must already have happened.
    const evidence = collectFailureEvidence({ liveIndex: live, stagingCopy: staging }, NO_ACTIVITY);

    expect(mocks.readActivity).toHaveBeenCalledTimes(1);
    expect(stat.mock.calls.map(([file]) => file)).toEqual(paths);
    expect(statfs.mock.calls.map(([file]) => file)).toEqual(paths);

    // Five stalled mounts cost one deadline, not five: the stats run together.
    await vi.advanceTimersByTimeAsync(FILE_EVIDENCE_TIMEOUT_MS);
    const lines = await evidence;
    expect(lines.slice(0, -1)).toEqual(
      STAGED_FILE_LABELS.map(
        (label) => `${label}: unavailable (timed out after ${FILE_EVIDENCE_TIMEOUT_MS} ms)`,
      ),
    );
    expect(lines.at(-1)).toBe('checkpoints: none completed, 0 in flight');
  });
});
