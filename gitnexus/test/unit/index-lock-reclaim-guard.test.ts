import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireIndexLock,
  IndexLockTimeoutError,
  type IndexLockHandle,
} from '../../src/storage/index-lock.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    renameSync: vi.fn(actual.renameSync),
    openSync: vi.fn(actual.openSync),
    writeSync: vi.fn(actual.writeSync),
    closeSync: vi.fn(actual.closeSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
let dir: string;
let lockPath: string;
let guardPath: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('GITNEXUS_INDEX_LOCK_BACKEND', 'file');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-reclaim-guard-'));
  lockPath = path.join(dir, 'analyze.lock');
  guardPath = `${lockPath}.guard`;
});

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('never admits B and C while A resumes a stale reclaim judgment', async () => {
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      v: 1,
      pid: 999999999,
      hostname: os.hostname(),
      startTime: null,
      token: 'dead-D',
      invocationId: 'dead-D',
      acquiredAt: '',
    }),
  );
  const entered: IndexLockHandle[] = [];
  const pending: Promise<unknown>[] = [];
  const start = () => {
    const task = acquireIndexLock(dir, { pollMs: 10, timeoutMs: 100 }).then(
      (handle) => {
        entered.push(handle);
      },
      (error: unknown) => error,
    );
    pending.push(task);
  };
  let deadReads = 0;
  let launchedB = false;
  let launchedC = false;
  vi.mocked(fs.readFileSync).mockImplementation((...args) => {
    const snapshot = actual.readFileSync(...args);
    if (args[0] === lockPath && String(snapshot).includes('dead-D')) {
      deadReads++;
      // Old protocol: pause after the pre-rename recheck. Guarded protocol:
      // pause at its fresh read while holding the guard. Reentrant calls model
      // another process running while A is suspended inside the syscall.
      if (!launchedB && (fs.existsSync(guardPath) || deadReads === 2)) {
        launchedB = true;
        start();
      }
    }
    return snapshot;
  });
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    const displacedLiveB =
      from === lockPath &&
      launchedB &&
      !String(actual.readFileSync(lockPath, 'utf8')).includes('dead-D');
    actual.renameSync(from, to);
    if (displacedLiveB && !launchedC) {
      launchedC = true;
      start(); // C verifies before A can inspect/restore the displaced inode.
    }
  });
  start();
  await vi.runAllTimersAsync();
  await Promise.all(pending);
  try {
    expect(launchedB).toBe(true);
    expect(entered).toHaveLength(1);
  } finally {
    for (const handle of entered) handle.release();
  }
});

it('keeps an incomplete creator excluded beyond the old malformed grace', async () => {
  // A stopped after O_EXCL creation, before either metadata write completed.
  fs.writeFileSync(guardPath, '');
  fs.writeFileSync(lockPath, '');
  const pending = acquireIndexLock(dir, { timeoutMs: 2500, pollMs: 10 }).catch((e) => e);
  await vi.advanceTimersByTimeAsync(1500);
  expect(fs.readFileSync(lockPath, 'utf8')).toBe('');
  expect(fs.openSync).not.toHaveBeenCalledWith(lockPath, 'wx');
  // Resume A. Completing its record and dropping its guard must still leave B
  // waiting on A's live workload lock, not reclaiming the former empty file.
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      v: 1,
      pid: process.pid,
      token: 'A',
      hostname: os.hostname(),
      startTime: null,
      invocationId: 'A',
      acquiredAt: '',
    }),
  );
  actual.unlinkSync(guardPath);
  await vi.runAllTimersAsync();
  expect(await pending).toBeInstanceOf(IndexLockTimeoutError);
  expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token).toBe('A');
});

it.each([0, -1, 120, Number.NaN])(
  'never steals an orphan guard with timeoutMs=%s',
  async (timeoutMs) => {
    const orphan = JSON.stringify({ pid: 999999999, token: 'dead-guard', hostname: os.hostname() });
    fs.writeFileSync(guardPath, orphan);
    const start = Date.now();
    const pending = acquireIndexLock(dir, { timeoutMs, pollMs: 250 }).catch((e) => e);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error).toBeInstanceOf(IndexLockTimeoutError);
    expect(error.holderKnown).toBe(false);
    expect(error.message).toContain(guardPath);
    expect(error.message).toContain('quiesced recovery');
    expect(Date.now() - start).toBe(timeoutMs > 0 ? timeoutMs : 30_000);
    expect(fs.readFileSync(guardPath, 'utf8')).toBe(orphan);
    expect(fs.existsSync(lockPath)).toBe(false);
  },
);

it.each(['', '{', '{"pid":0}', '{"pid":42,"hostname":"foreign","token":"x"}'])(
  'never takes over a guard based on its metadata: %s',
  async (contents) => {
    fs.writeFileSync(guardPath, contents);
    const pending = acquireIndexLock(dir, { timeoutMs: 1500, pollMs: 10 }).catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(IndexLockTimeoutError);
    expect(fs.readFileSync(guardPath, 'utf8')).toBe(contents);
    expect(fs.existsSync(lockPath)).toBe(false);
  },
);

it('caps guard wait by the remaining acquisition budget after waiting on a workload', async () => {
  const first = await acquireIndexLock(dir);
  const start = Date.now();
  const pending = acquireIndexLock(dir, {
    timeoutMs: 200,
    pollMs: 10,
    onWaitStart: () => {
      expect(fs.existsSync(guardPath)).toBe(false);
      fs.writeFileSync(guardPath, 'orphan');
    },
  }).catch((e) => e);
  await vi.runAllTimersAsync();
  expect(await pending).toBeInstanceOf(IndexLockTimeoutError);
  expect(Date.now() - start).toBe(200);
  first.release();
});

it('releases the guard before returning a workload handle', async () => {
  const handle = await acquireIndexLock(dir);
  expect(fs.existsSync(guardPath)).toBe(false);
  expect(fs.existsSync(lockPath)).toBe(true);
  handle.release();
});

for (const host of ['local-live', 'foreign']) {
  it.each([
    'unknown-version',
    'v',
    'hostname',
    'startTime',
    'invocationId',
    'acquiredAt',
    'empty-token',
  ])(`preserves a ${host} holder with compatible ownership and %s metadata`, async (field) => {
    const record: Record<string, unknown> = {
      v: 1,
      pid: host === 'local-live' ? process.pid : 999999999,
      hostname: host === 'local-live' ? os.hostname() : `${os.hostname()}-foreign`,
      startTime: null,
      token: 'compatible-holder',
      invocationId: 'older-writer',
      acquiredAt: '',
    };
    if (field === 'unknown-version') record.v = 999;
    else if (field === 'empty-token') record.token = '';
    else delete record[field];
    const contents = JSON.stringify(record);
    fs.writeFileSync(lockPath, contents);
    const pending = acquireIndexLock(dir, { timeoutMs: 1500, pollMs: 10 }).catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(IndexLockTimeoutError);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(contents);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(lockPath);
  });
}

it.each([
  'missing',
  'malformed',
  'partial',
  'mismatched',
  'released',
  'read-error',
  'unlink-error',
])('release is token-exact and one-shot after %s', async (mode) => {
  const handle = await acquireIndexLock(dir);
  if (mode === 'missing') actual.unlinkSync(lockPath);
  if (mode === 'malformed') fs.writeFileSync(lockPath, '{');
  if (mode === 'partial')
    fs.writeFileSync(lockPath, JSON.stringify({ token: handle.record.token }));
  if (mode === 'mismatched')
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'B' }));
  if (mode === 'read-error') {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error('read failed');
    });
  }
  if (mode === 'unlink-error') {
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw new Error('unlink failed');
    });
  }
  vi.mocked(fs.unlinkSync).mockClear();
  expect(() => handle.release()).not.toThrow();
  if (['missing', 'malformed', 'partial', 'mismatched', 'read-error'].includes(mode)) {
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  }
  // Even a successor still writing incomplete metadata must survive. Reset
  // to our old record afterward to prove the handle cannot retry either.
  fs.writeFileSync(lockPath, '');
  handle.release();
  expect(fs.existsSync(lockPath)).toBe(true);
  fs.writeFileSync(lockPath, JSON.stringify(handle.record));
  handle.release();
  expect(fs.existsSync(lockPath)).toBe(true);
});

it.each(['EPERM', 'EIO'])('fails closed on guard cleanup error %s', async (code) => {
  vi.mocked(fs.unlinkSync).mockImplementation((p) => {
    if (p === guardPath) throw Object.assign(new Error('guard cleanup failed'), { code });
    actual.unlinkSync(p);
  });
  await expect(acquireIndexLock(dir)).rejects.toThrow('guard cleanup failed');
  expect(fs.existsSync(guardPath)).toBe(true);
  expect(fs.existsSync(lockPath)).toBe(false);
});

it.each(['EACCES', 'EPERM', 'EROFS'])(
  'does not bypass a live owner when guard creation fails with %s',
  async (code) => {
    const owner = await acquireIndexLock(dir);
    const staging = path.join(dir, 'lbug.staging.active');
    fs.writeFileSync(staging, 'active writer');
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      if (args[0] === guardPath) throw Object.assign(new Error('guard denied'), { code });
      return actual.openSync(...args);
    });
    try {
      const pending = acquireIndexLock(dir, { timeoutMs: 100, pollMs: 10 }).catch((error) => error);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ message: 'guard denied', code });
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token).toBe(owner.record.token);
      expect(fs.readFileSync(staging, 'utf8')).toBe('active writer');
    } finally {
      owner.release();
    }
  },
);

it.each(['malformed', 'unreadable', 'guard'])(
  'fails closed on denied guard creation with %s ownership',
  async (mode) => {
    fs.writeFileSync(mode === 'guard' ? guardPath : lockPath, '{');
    vi.mocked(fs.openSync).mockImplementation(() => {
      throw Object.assign(new Error('guard denied'), { code: 'EACCES' });
    });
    if (mode === 'unreadable') {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('cannot read owner'), { code: 'EACCES' });
      });
    }
    await expect(acquireIndexLock(dir)).rejects.toThrow();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  },
);

it('never sweeps staging files with a lock-free handle', async () => {
  const staging = path.join(dir, 'lbug.staging.active');
  fs.writeFileSync(staging, 'do not touch');
  vi.mocked(fs.openSync).mockImplementation(() => {
    throw Object.assign(new Error('read-only'), { code: 'EROFS' });
  });
  const handle = await acquireIndexLock(dir);
  expect(handle.lockFree).toBe(true);
  expect(fs.readFileSync(staging, 'utf8')).toBe('do not touch');
  handle.release();
});

it('retries a transient delete-pending EPERM before claiming guard ownership', async () => {
  vi.mocked(fs.openSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('delete pending'), { code: 'EPERM' });
  });
  const pending = acquireIndexLock(dir, { timeoutMs: 100, pollMs: 10 });
  expect(fs.existsSync(lockPath)).toBe(false);
  await vi.runAllTimersAsync();
  const handle = await pending;
  expect(handle.lockFree).toBeUndefined();
  expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token).toBe(handle.record.token);
  expect(fs.existsSync(guardPath)).toBe(false);
  handle.release();
});

it.each([0, -1, 100])(
  'bounds persistent main-read EPERM with a large poll interval and timeout=%s',
  async (timeoutMs) => {
    vi.mocked(fs.readFileSync).mockImplementation((...args) => {
      if (args[0] === lockPath) throw Object.assign(new Error('main denied'), { code: 'EPERM' });
      return actual.readFileSync(...args);
    });
    const started = Date.now();
    const pending = acquireIndexLock(dir, { timeoutMs, pollMs: 60_000 }).catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ message: 'main denied', code: 'EPERM' });
    expect(Date.now() - started).toBe(timeoutMs > 0 ? timeoutMs : 30_000);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(guardPath)).toBe(false);
  },
);

it('keeps the permission deadline when later attempts encounter another guard', async () => {
  vi.mocked(fs.readFileSync).mockImplementation((...args) => {
    if (args[0] === lockPath) throw Object.assign(new Error('main denied'), { code: 'EPERM' });
    return actual.readFileSync(...args);
  });
  const started = Date.now();
  const pending = acquireIndexLock(dir, { timeoutMs: 0, pollMs: 10 }).catch((error) => error);
  fs.writeFileSync(guardPath, 'another guard');
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({ message: 'main denied', code: 'EPERM' });
  expect(Date.now() - started).toBe(30_000);
  expect(fs.readFileSync(guardPath, 'utf8')).toBe('another guard');
});

it('preserves an existing workload owner when a contender cannot clean its guard', async () => {
  const owner = await acquireIndexLock(dir);
  vi.mocked(fs.unlinkSync).mockImplementation((p) => {
    if (p === guardPath) throw new Error('guard cleanup failed');
    actual.unlinkSync(p);
  });
  await expect(acquireIndexLock(dir)).rejects.toThrow('guard cleanup failed');
  expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token).toBe(owner.record.token);
  expect(fs.unlinkSync).not.toHaveBeenCalledWith(lockPath);
  owner.release();
});

it.each(['mismatched', 'malformed', 'read-error', 'unlink-error'])(
  'does not blindly delete a workload record after guard cleanup fails: %s',
  async (mode) => {
    vi.mocked(fs.unlinkSync).mockImplementation((p) => {
      if (p === guardPath) {
        if (mode === 'mismatched')
          fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'successor' }));
        if (mode === 'malformed') fs.writeFileSync(lockPath, '{');
        if (mode === 'read-error')
          vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
            throw new Error('read denied');
          });
        throw new Error('guard cleanup failed');
      }
      if (mode === 'unlink-error') throw new Error('main cleanup failed');
      actual.unlinkSync(p);
    });
    await expect(acquireIndexLock(dir)).rejects.toThrow();
    expect(fs.existsSync(lockPath)).toBe(true);
    if (mode !== 'unlink-error') expect(fs.unlinkSync).not.toHaveBeenCalledWith(lockPath);
  },
);

it.each(['missing', 'malformed', 'mismatched'])(
  'does not delete a %s guard during cleanup',
  async (mode) => {
    vi.mocked(fs.readFileSync).mockImplementation((...args) => {
      if (args[0] === guardPath) {
        if (mode === 'missing') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return mode === 'malformed' ? '{' : JSON.stringify({ pid: process.pid, token: 'other' });
      }
      return actual.readFileSync(...args);
    });
    await expect(acquireIndexLock(dir)).rejects.toThrow('Cannot verify');
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(guardPath);
  },
);

it.each(['guard-write', 'main-write', 'guard-close', 'main-close', 'main-read'])(
  'does not admit a workload after %s fails',
  async (failure) => {
    const fds = new Map<number, string>();
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      const fd = actual.openSync(...args);
      fds.set(fd, String(args[0]));
      return fd;
    });
    vi.mocked(fs.writeSync).mockImplementation((...args) => {
      const target = fds.get(args[0]) === guardPath ? 'guard-write' : 'main-write';
      if (failure === target) throw Object.assign(new Error('write failed'), { code: 'EPERM' });
      return actual.writeSync(...args);
    });
    vi.mocked(fs.closeSync).mockImplementation((fd) => {
      actual.closeSync(fd);
      const target = fds.get(fd) === guardPath ? 'guard-close' : 'main-close';
      if (failure === target) throw new Error('close failed');
    });
    vi.mocked(fs.readFileSync).mockImplementation((...args) => {
      if (failure === 'main-read' && args[0] === lockPath) {
        throw Object.assign(new Error('read failed'), { code: 'EACCES' });
      }
      return actual.readFileSync(...args);
    });
    await expect(acquireIndexLock(dir)).rejects.toThrow();
    if (failure === 'guard-write') expect(fs.existsSync(guardPath)).toBe(true);
    if (failure === 'main-close') expect(fs.existsSync(lockPath)).toBe(false);
  },
);

it('does not reclaim a holder after an uncertain pid probe', async () => {
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      v: 1,
      pid: 12345,
      hostname: os.hostname(),
      token: 'live',
      startTime: null,
      invocationId: 'live',
      acquiredAt: '',
    }),
  );
  const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('probe unavailable'), { code: 'EIO' });
  });
  try {
    const pending = acquireIndexLock(dir, { timeoutMs: 100, pollMs: 10 }).catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(IndexLockTimeoutError);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token).toBe('live');
  } finally {
    probe.mockRestore();
  }
});
