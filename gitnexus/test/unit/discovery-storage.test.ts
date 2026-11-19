import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { DiscoveryMetadataCache, inspectStoragePath } from '../../src/storage/storage-resolver.js';

let repo: string;
let slot: string;
let primary: string;
let legacy: string;
let cache: DiscoveryMetadataCache;
const generation = `lbug.generation.${'a'.repeat(32)}`;

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-discovery-'));
  slot = path.join(repo, '.gitnexus');
  primary = path.join(slot, 'gitnexus.json');
  legacy = path.join(slot, 'meta.json');
  cache = new DiscoveryMetadataCache();
  await fs.mkdir(slot);
  await fs.writeFile(path.join(slot, 'lbug'), '');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(repo, { recursive: true, force: true });
});

const inspect = () => inspectStoragePath(slot, repo, cache);
const writeMetadata = (file: string, fields: Record<string, unknown> = {}) =>
  fs.writeFile(file, JSON.stringify({ repoPath: repo, storagePath: slot, ...fields }));

it('opens metadata before classifying the path and verifies its directory entry when no-follow is unavailable', async () => {
  await writeMetadata(primary);
  const calls: string[] = [];
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation((target, flags, mode) => {
    if (target === primary)
      calls.push(Number(flags) & constants.O_NOFOLLOW ? 'open-nofollow' : 'open');
    return open(target, flags, mode);
  });
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation((target, ...args) => {
    if (target === primary) calls.push('lstat');
    return lstat(target, ...args);
  });
  await expect(inspect()).resolves.toMatchObject({ state: 'owned' });
  expect(calls).toEqual(constants.O_NOFOLLOW ? ['open-nofollow'] : ['open', 'lstat']);
});

it('shares one descriptor-bound parse, then revalidates the current graph on warm reads', async () => {
  await writeMetadata(primary, { graphPath: generation, contentRetention: 'symbol' });
  await fs.writeFile(path.join(slot, generation), '');
  const read = vi.spyOn(fs, 'readFile');
  const enumerate = vi.spyOn(fs, 'readdir');
  const expected = { graphPath: path.join(slot, generation), contentRetention: 'symbol' };
  const [first, second] = await Promise.all([inspect(), inspect()]);
  expect([first.discovery, second.discovery]).toEqual([expected, expected]);
  await expect(inspect()).resolves.toMatchObject({ discovery: expected });
  await fs.unlink(path.join(slot, generation));
  const missing = await inspect();
  expect(missing).toMatchObject({ state: 'owned', hasCodeIndexDB: false });
  expect(missing.discovery).toBeUndefined();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0][0]).toHaveProperty('fd');
  expect(enumerate).not.toHaveBeenCalled();
});

it('enumerates a metadata-less directory to distinguish empty from unowned data', async () => {
  const enumerate = vi.spyOn(fs, 'readdir');
  await expect(inspect()).resolves.toMatchObject({ state: 'unowned' });
  await fs.unlink(path.join(slot, 'lbug'));
  await expect(inspect()).resolves.toMatchObject({ state: 'empty' });
  expect(enumerate).toHaveBeenCalledTimes(2);
});

it.each(['linux', 'win32'])(
  'keeps a slot with denied directory permissions unconfirmed on %s even with valid metadata',
  async (platform) => {
    await writeMetadata(primary);
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
      const error = Object.assign(new Error('denied'), { code: 'EACCES' });
      if (platform === 'win32') {
        // fs.access would succeed for this ACL; only opening the directory fails.
        vi.spyOn(fs, 'opendir').mockRejectedValue(error);
      } else {
        const access = fs.access.bind(fs);
        vi.spyOn(fs, 'access').mockImplementation(async (target, mode) => {
          if (target === slot) throw error;
          return access(target, mode);
        });
      }
      const denied = await inspect();
      expect(denied).toMatchObject({
        state: 'invalid_storage',
        reason: expect.stringContaining('EACCES:'),
      });
      expect(denied.discovery).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  },
);

it('reuses the published commit graph of a shared checkout slot', async () => {
  vi.stubEnv('GITNEXUS_HOME', repo);
  const store = path.join(repo, 'stores', 'fixture');
  const checkout = path.join(store, 'checkouts', 'checkout');
  const commit = path.join(store, 'commits', '1234567-deadbeef', 'lbug');
  await fs.mkdir(checkout, { recursive: true });
  await fs.mkdir(path.dirname(commit), { recursive: true });
  await fs.writeFile(commit, '');
  await writeMetadata(path.join(checkout, 'gitnexus.json'), {
    storagePath: checkout,
    graphPath: commit,
  });
  await expect(inspectStoragePath(checkout, repo, cache)).resolves.toMatchObject({
    state: 'owned',
    discovery: { graphPath: commit, contentRetention: 'full' },
  });
});

it('a later page reads the replacement while the older metadata parse is pending', async () => {
  await writeMetadata(primary, { contentRetention: 'full' });
  const replacement = path.join(slot, 'replacement');
  await writeMetadata(replacement, { contentRetention: 'none' });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announce!: () => void;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const realRead = fs.readFile.bind(fs) as typeof fs.readFile;
  const read = vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args) => {
    // Keep the descriptor's bytes but delay its result. Windows does not
    // consistently allow renaming over an open file, so swap its logical path
    // with an open spy there, as in shared-store-read-security.test.ts.
    const value = await realRead(...args);
    announce();
    await blocked;
    return value;
  });
  const older = inspect();
  await started;
  try {
    if (process.platform === 'win32') {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation((file, ...args) =>
        open(file === primary ? replacement : file, ...args),
      );
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, 'lstat').mockImplementation((file, ...args) =>
        lstat(file === primary ? replacement : file, ...args),
      );
    } else {
      await fs.rename(replacement, primary);
    }
    await expect(inspect()).resolves.toMatchObject({ discovery: { contentRetention: 'none' } });
  } finally {
    release();
    await older;
  }
  await expect(older).resolves.toMatchObject({ discovery: { contentRetention: 'full' } });
  await expect(inspect()).resolves.toMatchObject({ discovery: { contentRetention: 'none' } });
  expect(read).toHaveBeenCalledTimes(2);
});

it('uses legacy ownership and retention only on primary absence and ignores legacy graph pointers', async () => {
  await writeMetadata(legacy, { graphPath: generation });
  await expect(inspect()).resolves.toMatchObject({
    discovery: { graphPath: path.join(slot, 'lbug'), contentRetention: 'full' },
  });
  await fs.writeFile(primary, '{');
  const corrupt = await inspect();
  expect(corrupt.state).toBe('invalid_storage');
  expect(corrupt.discovery).toBeUndefined();
  await writeMetadata(primary, { contentRetention: 'unsupported', graphPath: '../other/lbug' });
  await expect(inspect()).resolves.toMatchObject({
    discovery: { graphPath: path.join(slot, 'lbug'), contentRetention: 'none' },
  });
  await writeMetadata(primary, { repoPath: path.join(repo, 'foreign') });
  const foreign = await inspect();
  expect(foreign.state).toBe('foreign');
  expect(foreign.discovery).toBeUndefined();
});

it.skipIf(process.platform === 'win32')(
  'does not use a symlinked primary as graph routing evidence',
  async () => {
    const target = path.join(repo, 'metadata');
    await writeMetadata(target, { graphPath: generation, contentRetention: 'symbol' });
    await fs.symlink(target, primary);
    await fs.writeFile(path.join(slot, generation), '');
    await expect(inspect()).resolves.toMatchObject({
      discovery: { graphPath: path.join(slot, 'lbug'), contentRetention: 'symbol' },
    });
    await writeMetadata(legacy, { graphPath: generation });
    await fs.unlink(target);
    // A missing target keeps the existing legacy fallback. Its pointer is ignored.
    await expect(inspect()).resolves.toMatchObject({
      discovery: { graphPath: path.join(slot, 'lbug'), contentRetention: 'full' },
    });
  },
);

it('keeps transient registry entries without trusting persisted discovery fields, and retries', async () => {
  vi.stubEnv('GITNEXUS_HOME', repo);
  const entry = { name: 'example', path: repo, storagePath: slot };
  await fs.writeFile(
    path.join(repo, 'registry.json'),
    JSON.stringify([
      {
        ...entry,
        discovery: { contentRetention: 'full', graphPath: 'unverified' },
      },
    ]),
  );
  await writeMetadata(primary, { contentRetention: 'none' });
  const read = fs.readFile.bind(fs) as typeof fs.readFile;
  let failed = false;
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (!failed && typeof args[0] === 'object' && 'fd' in args[0]) {
      failed = true;
      throw Object.assign(new Error('temporarily unreadable'), { code: 'EACCES' });
    }
    return read(...args);
  });
  const list = () => listRegisteredRepos({ validate: true, discovery: cache });
  const [unconfirmed] = await list();
  expect(unconfirmed).toMatchObject(entry);
  expect(unconfirmed).not.toHaveProperty('discovery');
  await expect(list()).resolves.toMatchObject([{ discovery: { contentRetention: 'none' } }]);
});
