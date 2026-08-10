/**
 * #2888 — the global registry write must not stage through a shared tmp path.
 *
 * `writeRegistry` used a FIXED `<home>/registry.json.tmp`. Every gitnexus
 * process on the machine writes that one file, so two of them could stage
 * through the same inode: the loser's `rename(tmp -> registry.json)` found
 * nothing there and rejected with ENOENT, which killed the MCP server during
 * startup (`LocalBackend.init` -> `refreshRepos`, nothing catches).
 *
 * Separate from repo-manager.test.ts: Vitest cannot vi.spyOn ESM namespace
 * exports of fs/promises, and these tests must drive `fs.rename` itself — a
 * delegating vi.mock is required (same split as repo-manager-rm-failure.test.ts
 * and repo-manager-ensure-ignore-readonly.test.ts, #1549).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';

type FsFn = (...args: never[]) => Promise<unknown>;

const fsCtx = vi.hoisted(() => ({
  renameMock: vi.fn(),
  realRename: null as ((src: string, dst: string) => Promise<void>) | null,
  realWriteFile: null as ((file: string, data: string, enc: string) => Promise<void>) | null,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const d = actual.default;
  fsCtx.realRename = d.rename.bind(d) as (src: string, dst: string) => Promise<void>;
  fsCtx.realWriteFile = d.writeFile.bind(d) as (
    file: string,
    data: string,
    enc: string,
  ) => Promise<void>;
  fsCtx.renameMock.mockImplementation((...args: never[]) =>
    (fsCtx.realRename as unknown as FsFn)(...args),
  );
  return {
    default: new Proxy(d, {
      get(target, prop) {
        if (prop === 'rename') return fsCtx.renameMock;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    }),
  };
});

import fs from 'fs/promises';
import {
  registerRepo,
  unregisterRepo,
  listRegisteredRepos,
  type RegistryEntry,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { _captureLogger } from '../../src/core/logger.js';
import { createTempDir } from '../helpers/test-db.js';

const meta: RepoMeta = {
  repoPath: '',
  lastCommit: 'abc1234',
  indexedAt: '2026-08-10T12:00:00.000Z',
  stats: { files: 1, nodes: 1 },
};

describe('writeRegistry — private tmp path per transaction (#2888)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepoA: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepoB: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;
  let home: string;
  let registryPath: string;

  /**
   * A second gitnexus process finishing its whole registry transaction inside
   * our own write window — the pre-#2716 shape, or a post-#2716 process whose
   * registry lock timed out and degraded to unlocked. It stages through the
   * FIXED `registry.json.tmp` the old code used, which is the collision.
   */
  const rivalWriterThenUs = async (src: string, dst: string): Promise<void> => {
    const rivalTmp = `${registryPath}.tmp`;
    const rival: RegistryEntry[] = [
      {
        name: 'rival',
        path: '/nonexistent/rival',
        storagePath: '/nonexistent/rival/.gitnexus',
        indexedAt: meta.indexedAt,
        lastCommit: meta.lastCommit,
      },
    ];
    await fsCtx.realWriteFile!(rivalTmp, JSON.stringify(rival, null, 2), 'utf-8');
    await fsCtx.realRename!(rivalTmp, registryPath);
    await fsCtx.realRename!(src, dst);
  };

  const readRegistryFromDisk = async (): Promise<RegistryEntry[]> =>
    JSON.parse(await fs.readFile(registryPath, 'utf-8')) as RegistryEntry[];

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-registry-atomic-home-');
    tmpRepoA = await createTempDir('gitnexus-registry-atomic-repo-a-');
    tmpRepoB = await createTempDir('gitnexus-registry-atomic-repo-b-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    home = tmpHome.dbPath;
    process.env.GITNEXUS_HOME = home;
    registryPath = path.join(home, 'registry.json');
    fsCtx.renameMock.mockClear();
    fsCtx.renameMock.mockImplementation((...args: never[]) =>
      (fsCtx.realRename as unknown as FsFn)(...args),
    );
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
    await tmpRepoA.cleanup();
    await tmpRepoB.cleanup();
  });

  it('survives a rival that publishes registry.json between our write and our rename', async () => {
    fsCtx.renameMock.mockImplementationOnce(rivalWriterThenUs);

    await expect(registerRepo(tmpRepoA.dbPath, meta, { name: 'ours' })).resolves.toBe('ours');

    // Last writer wins — the degraded-unlocked window is still lossy by
    // design, and this asserts only that it no longer CRASHES.
    expect((await readRegistryFromDisk()).map((e) => e.name)).toEqual(['ours']);
    expect(fsCtx.renameMock).toHaveBeenCalledTimes(1);
  });

  it('survives the same window on unregisterRepo (the fix lives in writeRegistry, not one caller)', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'seed' });
    fsCtx.renameMock.mockClear();
    fsCtx.renameMock.mockImplementationOnce(rivalWriterThenUs);

    await expect(unregisterRepo(tmpRepoA.dbPath)).resolves.toBeUndefined();

    expect(await readRegistryFromDisk()).toEqual([]);
    expect(fsCtx.renameMock).toHaveBeenCalledTimes(1);
  });

  it('gives every transaction its own tmp path inside the registry directory', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'a' });
    await registerRepo(tmpRepoB.dbPath, meta, { name: 'b' });

    const staged = fsCtx.renameMock.mock.calls.map((c) => c[0] as string);
    expect(staged).toHaveLength(2);
    // Distinct per transaction — this is the whole fix.
    expect(new Set(staged).size).toBe(2);
    // Never the shared name the crash was staged through.
    expect(staged).not.toContain(`${registryPath}.tmp`);
    // Same directory, so the rename stays a same-filesystem atomic operation.
    expect(staged.map((s) => path.dirname(s))).toEqual([home, home]);
  });

  it('removes its tmp file when the rename fails, leaving the previous registry intact', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'seed' });
    fsCtx.renameMock.mockClear();
    // EIO, not EBUSY/EPERM/EACCES: those are retryRename's retry codes, so
    // they would sleep and then fall through to the real rename.
    fsCtx.renameMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('mock io error'), { code: 'EIO' })),
    );

    await expect(registerRepo(tmpRepoB.dbPath, meta, { name: 'doomed' })).rejects.toThrow(
      /mock io error/,
    );

    expect(fsCtx.renameMock).toHaveBeenCalledTimes(1);
    // A random tmp suffix is not self-limiting the way the fixed name was:
    // without cleanup every failed publish would orphan another file forever.
    const leftovers = (await fs.readdir(home)).filter(
      (f) => f !== 'registry.json' && f.startsWith('registry.json'),
    );
    expect(leftovers).toEqual([]);
    expect((await readRegistryFromDisk()).map((e) => e.name)).toEqual(['seed']);
  });

  it('keeps serving a validating read when the prune write fails', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'gone' });
    fsCtx.renameMock.mockClear();
    fsCtx.renameMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('mock read-only home'), { code: 'EROFS' })),
    );

    const cap = _captureLogger();
    const entries = await listRegisteredRepos({ validate: true });
    cap.restore();

    // The caller gets the pruned view…
    expect(entries).toEqual([]);
    // …the failure is reported, not thrown (MCP startup has no handler)…
    expect(cap.records().filter((r) => /Could not persist the pruned/.test(r.msg))).toHaveLength(1);
    // …and the unpruned registry stays on disk for the next attempt.
    expect((await readRegistryFromDisk()).map((e) => e.name)).toEqual(['gone']);
    expect(fsCtx.renameMock).toHaveBeenCalledTimes(1);
  });
});
