/**
 * Unit tests for the cross-process index write lock (#2658).
 *
 * These exercise the lock's decision logic deterministically by pre-seeding
 * `analyze.lock` records and asserting acquire/steal/release/sweep behavior —
 * including the kill-recovery mechanism (a dead holder's lock is reclaimed) and
 * mutual exclusion (a live holder is waited on, never stolen). A real
 * two-process exclusion + SIGKILL-recovery test lives in
 * test/integration/analyze-index-lock-concurrency.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireIndexLock,
  sweepStagingArtifacts,
  IndexLockTimeoutError,
  type LockRecord,
} from '../../src/storage/index-lock.js';
import { classifyFtsBuildError } from '../../src/core/search/fts-indexes.js';

let dir: string;
const lockPath = () => path.join(dir, 'analyze.lock');

const seedLock = (overrides: Partial<LockRecord>): void => {
  const record: LockRecord = {
    v: 1,
    pid: 999999999, // implausible pid → dead by default
    hostname: os.hostname(),
    startTime: null,
    token: 'seed-token',
    invocationId: 'seed-invocation',
    acquiredAt: new Date().toISOString(),
    ...overrides,
  };
  writeFileSync(lockPath(), JSON.stringify(record));
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gnx-lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireIndexLock', () => {
  it('acquires a free directory and writes a record carrying our pid', async () => {
    const lock = await acquireIndexLock(dir);
    expect(existsSync(lockPath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(lockPath(), 'utf8')) as LockRecord;
    expect(onDisk).toMatchObject({ v: 1, pid: process.pid, hostname: os.hostname() });
    expect(lock.record.token).toBe(onDisk.token);
    lock.release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('reclaims a stale lock left by a dead process (kill recovery)', async () => {
    seedLock({ pid: 999999999, token: 'dead-holder' });
    const lock = await acquireIndexLock(dir, { timeoutMs: 2000 });
    const onDisk = JSON.parse(readFileSync(lockPath(), 'utf8')) as LockRecord;
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.token).not.toBe('dead-holder');
    lock.release();
  });

  it('waits on a live holder and times out instead of stealing (mutual exclusion)', async () => {
    // A live pid (our own) with a different token — never stale, so acquire
    // must block and then time out rather than clobber the holder.
    seedLock({ pid: process.pid, startTime: null, token: 'live-holder' });
    await expect(acquireIndexLock(dir, { timeoutMs: 300, pollMs: 20 })).rejects.toBeInstanceOf(
      IndexLockTimeoutError,
    );
    // The live holder's record is untouched.
    const onDisk = JSON.parse(readFileSync(lockPath(), 'utf8')) as LockRecord;
    expect(onDisk.token).toBe('live-holder');
  });

  it('surfaces the holder identity on timeout', async () => {
    seedLock({ pid: process.pid, startTime: null, token: 'live-holder', invocationId: 'held-run' });
    await expect(acquireIndexLock(dir, { timeoutMs: 200, pollMs: 20 })).rejects.toMatchObject({
      holder: { invocationId: 'held-run', pid: process.pid },
    });
  });

  it.skipIf(process.platform !== 'linux')(
    'treats a reused pid (live pid, different start time) as stale',
    async () => {
      // Our pid is alive but the seeded start time cannot match it → reused.
      seedLock({ pid: process.pid, startTime: '1', token: 'reused-pid' });
      const lock = await acquireIndexLock(dir, { timeoutMs: 2000 });
      const onDisk = JSON.parse(readFileSync(lockPath(), 'utf8')) as LockRecord;
      expect(onDisk.token).not.toBe('reused-pid');
      lock.release();
    },
  );

  it('reclaims an empty lock file (crash between O_EXCL create and record write) without hanging', async () => {
    // Pre-fix, readRecord→null hot-looped forever here. Post-fix it reclaims
    // the malformed orphan after the grace and acquires.
    writeFileSync(lockPath(), '');
    const lock = await acquireIndexLock(dir, { timeoutMs: 5000, pollMs: 20 });
    const onDisk = JSON.parse(readFileSync(lockPath(), 'utf8')) as LockRecord;
    expect(onDisk.pid).toBe(process.pid);
    lock.release();
  });

  it('reclaims a partial/malformed record (valid JSON, missing token) without hanging', async () => {
    writeFileSync(lockPath(), '{"pid":123}');
    const lock = await acquireIndexLock(dir, { timeoutMs: 5000, pollMs: 20 });
    const onDisk = JSON.parse(readFileSync(lockPath(), 'utf8')) as LockRecord;
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.token.length).toBeGreaterThan(0);
    lock.release();
  });

  it('honors GITNEXUS_INDEX_LOCK_TIMEOUT_MS as the wait ceiling (bounds pid-reuse hangs)', async () => {
    // A live holder we cannot steal (own pid, no start-time recorded). Without a
    // finite ceiling this would hang; the env var must bound it (#2658).
    seedLock({ pid: process.pid, startTime: null, token: 'live-holder' });
    const prev = process.env.GITNEXUS_INDEX_LOCK_TIMEOUT_MS;
    process.env.GITNEXUS_INDEX_LOCK_TIMEOUT_MS = '150';
    try {
      // No explicit timeoutMs → the env ceiling applies (not the 10-min default).
      await expect(acquireIndexLock(dir, { pollMs: 20 })).rejects.toBeInstanceOf(
        IndexLockTimeoutError,
      );
    } finally {
      if (prev === undefined) delete process.env.GITNEXUS_INDEX_LOCK_TIMEOUT_MS;
      else process.env.GITNEXUS_INDEX_LOCK_TIMEOUT_MS = prev;
    }
  });
});

describe('release', () => {
  it('does not remove a lock that has been re-taken by another owner', async () => {
    const lock = await acquireIndexLock(dir);
    // Simulate the file being replaced by a different owner after we acquired.
    seedLock({ pid: process.pid, token: 'someone-else' });
    lock.release();
    expect(existsSync(lockPath())).toBe(true); // not ours → left intact
    const onDisk = JSON.parse(readFileSync(lockPath(), 'utf8')) as LockRecord;
    expect(onDisk.token).toBe('someone-else');
  });

  it('is idempotent', async () => {
    const lock = await acquireIndexLock(dir);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });
});

describe('sweepStagingArtifacts', () => {
  it('removes only staging files, never the live index or its sidecars', () => {
    const files = [
      'lbug',
      'lbug.wal',
      'lbug.shadow',
      'lbug.new',
      'lbug.new.wal',
      'lbug.new.wal.checkpoint',
      'lbug.staging.abc-123',
      'lbug.staging.abc-123.wal',
      'lbug.staging.abc-123.shadow',
      'gitnexus.json',
    ];
    for (const f of files) writeFileSync(path.join(dir, f), 'x');

    sweepStagingArtifacts(dir);

    const survives = (f: string) => existsSync(path.join(dir, f));
    expect(survives('lbug')).toBe(true);
    expect(survives('lbug.wal')).toBe(true);
    expect(survives('lbug.shadow')).toBe(true);
    expect(survives('gitnexus.json')).toBe(true);
    expect(survives('lbug.new')).toBe(false);
    expect(survives('lbug.new.wal')).toBe(false);
    expect(survives('lbug.new.wal.checkpoint')).toBe(false);
    expect(survives('lbug.staging.abc-123')).toBe(false);
    expect(survives('lbug.staging.abc-123.wal')).toBe(false);
    expect(survives('lbug.staging.abc-123.shadow')).toBe(false);
  });

  it('runs the sweep automatically on acquire', async () => {
    writeFileSync(path.join(dir, 'lbug.staging.orphan'), 'x');
    writeFileSync(path.join(dir, 'lbug'), 'x');
    const lock = await acquireIndexLock(dir);
    expect(existsSync(path.join(dir, 'lbug.staging.orphan'))).toBe(false);
    expect(existsSync(path.join(dir, 'lbug'))).toBe(true);
    lock.release();
  });
});

describe('classifyFtsBuildError', () => {
  it('classifies IO/rename/checkpoint/corruption failures as integrity', () => {
    expect(
      classifyFtsBuildError(
        'IO exception: Error renaming file lbug.new.wal to lbug.new.wal.checkpoint. ErrorMessage: No such file or directory',
      ),
    ).toBe('integrity');
    expect(classifyFtsBuildError('checkpoint failed')).toBe('integrity');
    expect(classifyFtsBuildError('database file is corrupt')).toBe('integrity');
    expect(classifyFtsBuildError('write failed: no space left on device (ENOSPC)')).toBe(
      'integrity',
    );
  });

  it('classifies row-level tokenizer failures as capability (degrade)', () => {
    expect(classifyFtsBuildError('Failed calling LOWER: Invalid UTF-8')).toBe('capability');
    expect(classifyFtsBuildError('tokenizer error on row 5')).toBe('capability');
  });

  it('defaults unknown failures to capability so runs are not newly failed', () => {
    expect(classifyFtsBuildError('some unrecognised message')).toBe('capability');
    expect(classifyFtsBuildError('missing indexes after build: File.name_fts')).toBe('capability');
  });

  it('lets a row-level tokenizer error win even if it mentions an integrity word', () => {
    // A tokenizer error is a bad row, not a broken build — must still degrade.
    expect(classifyFtsBuildError('Invalid UTF-8 during io exception path')).toBe('capability');
  });
});
