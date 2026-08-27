/**
 * The per-group sync lock (R9): two concurrent syncs of one group cannot lose
 * one another's writes, and a sync that cannot be protected does not run.
 *
 * The exclusion cases contend with a REAL second process (`group-sync-lock-child.mjs`)
 * rather than an in-process mock: the default backend's exclusion is a kernel
 * socket binding and the file backend's is an O_EXCL create, so nothing observed
 * inside one process can prove either.
 *
 * Nothing here is platform-skipped. The cases that need the FILE backend pin it
 * explicitly (`GITNEXUS_INDEX_LOCK_BACKEND=file`) — the pin is load-bearing, not
 * incidental: on Linux and Windows `selectBackend()` answers `socket`, and the
 * socket backend never touches the filesystem, so an unpinned filesystem-failure
 * case would measure nothing on two of the three platforms.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncGroup } from '../../../src/core/group/sync.js';
import {
  GROUP_SYNC_LOCK_TIMEOUT_MS,
  GroupSyncLockError,
  getGroupSyncLockDir,
  withGroupSyncLock,
} from '../../../src/core/group/group-lock.js';
import { GroupService } from '../../../src/core/group/service.js';
import { makeGroupToolPort } from '../../unit/group/fixtures.js';
import type { LockRecord } from '../../../src/storage/index-lock.js';
import { CLI_SPAWN_PREFIX, tsxLoaderUrl } from '../../helpers/cli-entry.js';
import type { GroupConfig, StoredContract } from '../../../src/core/group/types.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');
const childScript = path.resolve(repoRoot, 'test', 'fixtures', 'group-sync-lock-child.mjs');
const groupLockSource = path.resolve(repoRoot, 'src', 'core', 'group', 'group-lock.ts');
const indexLockSpecifier = '../../../src/storage/index-lock.js';
const groupLockSpecifier = '../../../src/core/group/group-lock.js';

const makeConfig = (name: string): GroupConfig => ({
  version: 1,
  name,
  description: '',
  repos: {},
  links: [],
  packages: {},
  detect: {
    http: true,
    grpc: false,
    thrift: false,
    topics: false,
    shared_libs: false,
    includes: false,
    workspace_deps: false,
    embedding_fallback: false,
  },
  matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
});

const parentContract: StoredContract = {
  contractId: 'http::GET::/api/parent',
  type: 'http',
  role: 'provider',
  symbolUid: 'uid-parent',
  symbolRef: { filePath: 'src/parent.ts', name: 'Parent.get' },
  symbolName: 'Parent.get',
  confidence: 0.9,
  meta: { method: 'GET', path: '/api/parent' },
  repo: 'app/parent',
};

/** A persisting sync driven entirely off an extractor override (no repo index). */
const runSync = (groupDir: string) =>
  syncGroup(makeConfig(path.basename(groupDir)), {
    groupDir,
    extractorOverride: async () => [parentContract],
  });

const contractsPath = (groupDir: string): string => path.join(groupDir, 'contracts.json');
const readContracts = (groupDir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(contractsPath(groupDir), 'utf8')) as Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within timeout');
    await sleep(25);
  }
};

const waitForExit = (proc: ChildProcess, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

let home: string;
const children: ChildProcess[] = [];

/** Create `<home>/groups/<name>` with a group.yaml, the way `group create` does. */
const makeGroup = (name: string): string => {
  const dir = path.join(home, 'groups', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'group.yaml'),
    `version: 1\nname: ${name}\ndescription: ''\nrepos: {}\nlinks: []\n`,
  );
  return dir;
};

/**
 * Spawn the holder. tsx-on-source (not `dist/`) so the child runs the same
 * module this process imported — the lock's directory and endpoint derivation
 * must agree across the two, and a stale build would silently prove nothing.
 */
const spawnHolder = (opts: {
  groupDir: string;
  marker: string;
  holdMs?: number;
  contracts?: string;
  released?: string;
  backend?: string;
}): ChildProcess => {
  const child = spawn(process.execPath, ['--import', tsxLoaderUrl(), childScript], {
    env: {
      ...process.env,
      GROUP_LOCK_MODULE: pathToFileURL(groupLockSource).href,
      GROUP_DIR: opts.groupDir,
      MARKER: opts.marker,
      HOLD_MS: String(opts.holdMs ?? 0),
      ...(opts.contracts ? { CONTRACTS: opts.contracts } : {}),
      ...(opts.released ? { RELEASED: opts.released } : {}),
      ...(opts.backend ? { GITNEXUS_INDEX_LOCK_BACKEND: opts.backend } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
};

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'gnx-group-lock-'));
});

afterEach(async () => {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  }
  children.length = 0;
  vi.doUnmock(indexLockSpecifier);
  vi.resetModules();
  delete process.env.GITNEXUS_INDEX_LOCK_BACKEND;
  delete process.env.GITNEXUS_INDEX_LOCK_TIMEOUT_MS;
  rmSync(home, { recursive: true, force: true });
});

describe('group sync lock — uncontended (regression gate)', () => {
  it('a single sync completes and writes contracts.json exactly as before', async () => {
    const groupDir = makeGroup('solo');
    const result = await runSync(groupDir);

    expect(result.registryOutcome).toBe('written');
    expect(result.contracts).toHaveLength(1);
    expect(existsSync(contractsPath(groupDir))).toBe(true);
    expect((readContracts(groupDir).contracts as unknown[]).length).toBe(1);
  }, 60_000);

  it('holds the lock on <groupDir>/sync-lock, never on the group directory itself', async () => {
    // KTD3. `acquireIndexLock`'s file backend writes `analyze.lock` into the
    // directory it is handed, so handing it the group directory would drop a
    // lock file beside contracts.json and share a namespace with anything else
    // that ever locks a group. Pin the file backend: on the socket backend the
    // lock leaves no filesystem trace at all, so this would assert nothing.
    process.env.GITNEXUS_INDEX_LOCK_BACKEND = 'file';
    const groupDir = makeGroup('located');
    expect(getGroupSyncLockDir(groupDir)).toBe(path.join(groupDir, 'sync-lock'));

    await runSync(groupDir);

    expect(existsSync(getGroupSyncLockDir(groupDir))).toBe(true);
    expect(existsSync(path.join(groupDir, 'analyze.lock'))).toBe(false);
  }, 60_000);
});

describe('group sync lock — cross-process exclusion', () => {
  it('makes the second sync wait, so the final registry is the LATER sync, not the first', async () => {
    // The child writes its own contracts.json LAST, immediately before releasing.
    // Without the lock the parent's sync would finish first and the child's write
    // would land on top of it — the lost update this exists to prevent. With the
    // lock the parent cannot start persisting until the child is done, so the
    // final file is the parent's.
    const groupDir = makeGroup('contended');
    const marker = path.join(home, 'held.marker');
    const released = path.join(home, 'released.marker');
    const HOLD_MS = 1500;

    spawnHolder({
      groupDir,
      marker,
      holdMs: HOLD_MS,
      contracts: contractsPath(groupDir),
      released,
    });
    await waitFor(() => existsSync(marker), 60_000);

    const startedAt = Date.now();
    const result = await runSync(groupDir);
    const finishedAt = Date.now();

    expect(result.registryOutcome).toBe('written');
    // The holder released before we finished persisting.
    const releasedAt = Number(readFileSync(released, 'utf8'));
    expect(finishedAt).toBeGreaterThanOrEqual(releasedAt);
    // And we genuinely waited rather than racing through: the hold began before
    // our clock started, so a lock-free run would have finished near-instantly.
    expect(finishedAt - startedAt).toBeGreaterThan(HOLD_MS / 2);
    // The surviving registry is ours, not the holder's.
    const written = readContracts(groupDir);
    expect(written.writtenBy).toBeUndefined();
    expect((written.contracts as StoredContract[])[0].contractId).toBe(parentContract.contractId);
  }, 120_000);

  it('lets a waiting sync proceed once the holder dies', async () => {
    const groupDir = makeGroup('bereaved');
    const marker = path.join(home, 'held.marker');
    const child = spawnHolder({ groupDir, marker }); // holds until killed
    await waitFor(() => existsSync(marker), 60_000);

    let settled = false;
    const pending = runSync(groupDir).finally(() => {
      settled = true;
    });
    await sleep(600);
    expect(settled).toBe(false); // blocked on the live holder

    child.kill('SIGKILL');
    await waitForExit(child, 30_000);

    const result = await pending;
    expect(result.registryOutcome).toBe('written');
    expect(existsSync(contractsPath(groupDir))).toBe(true);
  }, 120_000);

  it('does not make syncs of two different groups contend', async () => {
    // The holder never releases, so if the lock were group-agnostic this sync
    // would block until the wait ceiling and the case would fail by timeout.
    const held = makeGroup('group-a');
    const other = makeGroup('group-b');
    const marker = path.join(home, 'held.marker');
    const child = spawnHolder({ groupDir: held, marker });
    await waitFor(() => existsSync(marker), 60_000);

    const result = await runSync(other);

    expect(result.registryOutcome).toBe('written');
    expect(existsSync(contractsPath(other))).toBe(true);
    expect(existsSync(contractsPath(held))).toBe(false);
    expect(child.exitCode).toBeNull(); // still holding group-a
  }, 120_000);
});

describe('group sync lock — fails closed', () => {
  /** Occupy `<groupDir>/sync-lock` with a regular file: the lock directory then
   *  cannot be created (EEXIST), on every platform, with no permission games. */
  const blockLockDir = (groupDir: string): void => {
    writeFileSync(getGroupSyncLockDir(groupDir), 'not a directory');
  };

  it('refuses to sync when the sync-lock directory cannot be created', async () => {
    process.env.GITNEXUS_INDEX_LOCK_BACKEND = 'file';
    const groupDir = makeGroup('blocked');
    blockLockDir(groupDir);

    await expect(runSync(groupDir)).rejects.toBeInstanceOf(GroupSyncLockError);
    expect(existsSync(contractsPath(groupDir))).toBe(false);
  }, 60_000);

  it('rejects the lock-free handle a read-only filesystem produces', async () => {
    // KTD4.2. `acquireIndexLock` answers EROFS/EACCES/EPERM with a no-op handle
    // that is byte-identical in shape to a real one — right for `analyze`, fatal
    // here, because the sync would go on to write with nothing protecting it.
    // The failure is injected at the one syscall that produces it, so the REAL
    // acquire path runs and the REAL no-op handle comes back; a permissions
    // fixture would have to be skipped on Windows, where mode bits do not deny
    // directory creation, and skipping is what makes this guarantee a fiction.
    process.env.GITNEXUS_INDEX_LOCK_BACKEND = 'file';
    const groupDir = makeGroup('readonly');
    const lockDir = getGroupSyncLockDir(groupDir);

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      const mkdirSync: typeof actual.mkdirSync = ((
        p: Parameters<typeof actual.mkdirSync>[0],
        o,
      ) => {
        if (String(p) === lockDir) {
          const err: NodeJS.ErrnoException = new Error(`EACCES: permission denied, mkdir '${p}'`);
          err.code = 'EACCES';
          throw err;
        }
        return actual.mkdirSync(p, o);
      }) as typeof actual.mkdirSync;
      return { ...actual, mkdirSync, default: { ...actual, mkdirSync } };
    });
    const fresh = await import(groupLockSpecifier);

    let ran = false;
    await expect(
      fresh.withGroupSyncLock(groupDir, async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ name: 'GroupSyncLockError', reason: 'lock-free' });
    expect(ran).toBe(false);

    vi.doUnmock('node:fs');
    vi.resetModules();
  }, 60_000);

  it('propagates an acquire timeout instead of running the sync unprotected', async () => {
    const groupDir = makeGroup('timed-out');
    const holder: LockRecord = {
      v: 1,
      pid: 4242,
      hostname: os.hostname(),
      startTime: null,
      token: 't',
      invocationId: 'other-sync',
      acquiredAt: new Date().toISOString(),
    };

    vi.resetModules();
    vi.doMock(indexLockSpecifier, async () => {
      const actual =
        await vi.importActual<typeof import('../../../src/storage/index-lock.js')>(
          indexLockSpecifier,
        );
      return {
        ...actual,
        acquireIndexLock: async () => {
          throw new actual.IndexLockTimeoutError(holder, 600_000);
        },
      };
    });
    const fresh = await import(groupLockSpecifier);

    let ran = false;
    const err = await fresh
      .withGroupSyncLock(groupDir, async () => {
        ran = true;
      })
      .then(
        () => null,
        (e: Error) => e,
      );

    expect(ran).toBe(false);
    expect(err).toMatchObject({ name: 'GroupSyncLockError', reason: 'timeout' });
    // The wording is the subject of the suite below; here it only has to be the
    // group lock's own message rather than the primitive's raw failure text.
    expect((err as Error).message).toContain('sync lock on group "timed-out"');
    // The original error is preserved as `cause`, holder metadata intact. Asserted
    // structurally, not with `instanceof`: this case drives a freshly re-evaluated
    // module graph, whose `IndexLockTimeoutError` is a different class object from
    // the statically imported one.
    expect((err as { cause?: unknown }).cause).toMatchObject({
      name: 'IndexLockTimeoutError',
      holder: { invocationId: 'other-sync' },
      holderKnown: true,
    });
  }, 60_000);

  it('passes its own wait ceiling, so GITNEXUS_INDEX_LOCK_TIMEOUT_MS cannot make it unbounded', async () => {
    // `resolveTimeoutMs` prefers an explicit argument over the env var, whose
    // `<= 0` case resolves to POSITIVE_INFINITY — inheriting it would turn this
    // lock's fail-closed timeout into a hang.
    process.env.GITNEXUS_INDEX_LOCK_TIMEOUT_MS = '0';
    const groupDir = makeGroup('ceiling');
    const seen: Array<Record<string, unknown>> = [];

    vi.resetModules();
    vi.doMock(indexLockSpecifier, async () => {
      const actual =
        await vi.importActual<typeof import('../../../src/storage/index-lock.js')>(
          indexLockSpecifier,
        );
      return {
        ...actual,
        acquireIndexLock: async (_dir: string, o: Record<string, unknown>) => {
          seen.push(o);
          return { record: {} as LockRecord, release: () => {} };
        },
      };
    });
    const fresh = await import(groupLockSpecifier);

    await fresh.withGroupSyncLock(groupDir, async () => undefined);

    expect(seen).toHaveLength(1);
    expect(seen[0].timeoutMs).toBe(GROUP_SYNC_LOCK_TIMEOUT_MS);
    expect(Number.isFinite(seen[0].timeoutMs as number)).toBe(true);
  }, 60_000);
});

describe('group sync lock — what the timeout says happened', () => {
  /**
   * Drive `withGroupSyncLock` against an `acquireIndexLock` that waits `waitMs`
   * and then times out exactly as the primitive does, and hand back the error
   * the wrapper produced.
   *
   * `reportedMs` is the figure baked into the INHERITED message and is
   * deliberately nowhere near the real wait: a wrapper that re-uses the
   * primitive's text reports that number, one that times the acquisition itself
   * reports `waitMs`. `IndexLockTimeoutError` carries no elapsed field, so the
   * two are the only places the figure can come from.
   */
  const timedOutAcquire = async (opts: {
    groupDir: string;
    waitMs: number;
    reportedMs: number;
    holderKnown: boolean;
  }): Promise<Error | null> => {
    // `holderKnown: false` mirrors `unknownHolder()` in index-lock.ts: the
    // socket backend exposes no owner metadata, so the record is a placeholder
    // (`pid -1`) that no message may present as a real holder.
    const holder: LockRecord = {
      v: 1,
      pid: opts.holderKnown ? 4242 : -1,
      hostname: os.hostname(),
      startTime: null,
      token: opts.holderKnown ? 't' : '',
      invocationId: opts.holderKnown ? 'other-sync' : '<unreadable>',
      acquiredAt: opts.holderKnown ? new Date().toISOString() : '',
    };

    vi.resetModules();
    vi.doMock(indexLockSpecifier, async () => {
      const actual =
        await vi.importActual<typeof import('../../../src/storage/index-lock.js')>(
          indexLockSpecifier,
        );
      return {
        ...actual,
        acquireIndexLock: async () => {
          await sleep(opts.waitMs);
          throw new actual.IndexLockTimeoutError(holder, opts.reportedMs, opts.holderKnown);
        },
      };
    });
    const fresh = await import(groupLockSpecifier);

    return fresh
      .withGroupSyncLock(opts.groupDir, async () => undefined)
      .then(
        () => null,
        (e: Error) => e,
      );
  };

  const waitedMsIn = (message: string): number =>
    Number(/Timed out after (\d+)ms/.exec(message)?.[1] ?? NaN);

  it('names the group, the operation, and the wait it measured itself', async () => {
    const groupDir = makeGroup('slow-group');
    const err = await timedOutAcquire({
      groupDir,
      waitMs: 120,
      reportedMs: 600_000,
      holderKnown: true,
    });

    expect(err).toMatchObject({ name: 'GroupSyncLockError', reason: 'timeout' });
    const msg = String(err?.message);
    expect(msg).toContain('sync lock on group "slow-group"');
    expect(msg).toContain(getGroupSyncLockDir(groupDir));
    expect(msg).toContain('was not synced');

    // The elapsed wait is this wrapper's own measurement. The primitive
    // announced 600000ms; the acquisition actually took ~120ms, and only a
    // wrapper that timed it can say so. Half the sleep is the floor, the way
    // the exclusion case above bounds its own wait — a timer cannot fire at
    // half its delay on any host.
    const waited = waitedMsIn(msg);
    expect(Number.isFinite(waited)).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(60);
    expect(msg).not.toContain('600000');

    // The primitive's error is still the cause, so nothing is lost by rewording.
    expect((err as { cause?: unknown }).cause).toMatchObject({
      name: 'IndexLockTimeoutError',
      holder: { invocationId: 'other-sync' },
    });
  }, 60_000);

  it('does not blame an analyze, and does not name a holder the backend cannot identify', async () => {
    // The inherited message says "another gitnexus analyze" holds the lock —
    // a cause this path cannot establish (nothing but a group sync ever locks
    // `<groupDir>/sync-lock`), and on the socket backend it cannot name the
    // holder at all: `holderKnown` is false and `holder.pid` is the placeholder
    // -1. Fail-closed made both claims user-visible for the first time.
    const groupDir = makeGroup('anonymous-holder');
    const err = await timedOutAcquire({
      groupDir,
      waitMs: 0,
      reportedMs: 600_000,
      holderKnown: false,
    });

    const msg = String(err?.message);
    expect(msg).toContain('sync lock on group "anonymous-holder"');
    expect(msg).not.toMatch(/analyze/i);
    // No pid is quoted at all — not the placeholder, not any other. Matched on
    // the shape the message would use to name one, so a random temp-directory
    // segment cannot satisfy it by accident.
    expect(msg).not.toMatch(/pid\s+-?\d+/i);
    expect(msg).toContain('cannot identify the holder');
  }, 60_000);

  it('names the holder when the backend does identify one', async () => {
    // The other half of the branch: on the file backend the record is real, and
    // suppressing it would throw away the one thing that lets an operator find
    // the process to wait for.
    const groupDir = makeGroup('identified-holder');
    const err = await timedOutAcquire({
      groupDir,
      waitMs: 0,
      reportedMs: 600_000,
      holderKnown: true,
    });

    const msg = String(err?.message);
    expect(msg).toMatch(/pid 4242/);
    expect(msg).toContain(os.hostname());
    expect(msg).toContain('other-sync');
    expect(msg).not.toMatch(/analyze/i);
    expect(msg).not.toContain('cannot identify the holder');
  }, 60_000);

  it('control: an acquisition that succeeds raises nothing', async () => {
    // No mock: the real lock, uncontended. Without this, every assertion above
    // could be satisfied by a wrapper that failed on every acquisition.
    const groupDir = makeGroup('uncontended-message');

    await expect(withGroupSyncLock(groupDir, async () => 'ran')).resolves.toBe('ran');
  }, 60_000);
});

describe('group sync lock — how a lock failure surfaces', () => {
  it('fails the `group sync` command with the lock message, not a stack trace', () => {
    process.env.GITNEXUS_INDEX_LOCK_BACKEND = 'file';
    const groupDir = makeGroup('cli-blocked');
    writeFileSync(getGroupSyncLockDir(groupDir), 'not a directory');

    const run = spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'group', 'sync', 'cli-blocked'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, GITNEXUS_HOME: home, GITNEXUS_INDEX_LOCK_BACKEND: 'file' },
    });

    expect(run.status).not.toBe(0);
    // The message goes through pino (`console.error` is an eslint error in this
    // package — a forcing function for that migration), so it arrives as a JSON
    // envelope rather than raw text. Read the `msg` field: asserting the raw
    // substring would pass only by accident of quoting, and would go green
    // again if the line were ever downgraded to a bare stderr write.
    const logged = run.stderr
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as { level: number; msg: string });
    const failure = logged.find((entry) => entry.msg.includes('Did not sync group'));
    expect(failure, `no failure log in stderr: ${run.stderr}`).toBeDefined();
    expect(failure?.level).toBe(50); // pino error
    expect(failure?.msg).toContain('Did not sync group "cli-blocked"');
    expect(failure?.msg).toContain('sync lock');
    expect(run.stderr).not.toContain('GroupSyncLockError: ');
    expect(run.stderr).not.toMatch(/^\s+at /m); // no stack frames
    expect(existsSync(contractsPath(groupDir))).toBe(false);
  }, 180_000);

  it('returns a lock failure through group_sync as an error payload, never an empty success', async () => {
    process.env.GITNEXUS_INDEX_LOCK_BACKEND = 'file';
    const groupDir = makeGroup('mcp-blocked');
    writeFileSync(getGroupSyncLockDir(groupDir), 'not a directory');
    process.env.GITNEXUS_HOME = home;

    try {
      const service = new GroupService(makeGroupToolPort(home));
      const payload = (await service.groupSync({ name: 'mcp-blocked' })) as Record<string, unknown>;

      expect(typeof payload.error).toBe('string');
      expect(String(payload.error)).toContain('sync lock');
      // The failure must not masquerade as a clean sync of an empty group.
      expect(payload.contracts).toBeUndefined();
      expect(payload.registryOutcome).toBeUndefined();
      expect(existsSync(contractsPath(groupDir))).toBe(false);
    } finally {
      delete process.env.GITNEXUS_HOME;
    }
  }, 120_000);
});
