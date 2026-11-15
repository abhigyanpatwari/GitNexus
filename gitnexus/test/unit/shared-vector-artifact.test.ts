import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { retainSharedVectorArtifact } from '../../src/storage/shared-vector-artifact.js';
import type { PublishedVectorGeneration } from '../../src/storage/vector-generation.js';

const generation: PublishedVectorGeneration = {
  version: 1,
  identity: 'b'.repeat(64),
  graphGeneration: 'a'.repeat(32),
  vectorIdentity: 'c'.repeat(64),
  inputIdentity: 'd'.repeat(64),
  dimensions: 4,
  nodes: 1,
  chunks: 1,
  indexKind: 'exact',
};
let root: string,
  source: string,
  destination: string,
  original: string,
  retained: string,
  preparing: string;
const differentDevice = () => Object.assign(new Error('Different filesystem'), { code: 'EXDEV' });
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-retain-vectors-')));
  source = path.join(root, 'source');
  destination = path.join(root, 'destination');
  original = path.join(source, 'embeddings', generation.identity, 'vectors');
  retained = path.join(destination, 'embeddings', generation.identity, 'vectors');
  preparing = path.join(destination, 'embeddings', `.retain-${generation.identity}`);
  await fs.mkdir(path.dirname(original), { recursive: true });
  await fs.mkdir(destination);
  // Filesystem ownership fixture; native immutability/identity is covered by
  // embedding-vector-store.test.ts and embedding-job-controller.test.ts.
  await fs.writeFile(original, 'completed immutable vectors');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it('retains an independent hard link without copying or rewriting it on retry', async () => {
  const copy = vi.spyOn(fs, 'copyFile');
  await retainSharedVectorArtifact(source, destination, generation);
  const inode = (await fs.stat(retained)).ino;
  expect(inode).toBe((await fs.stat(original)).ino);
  await retainSharedVectorArtifact(source, destination, generation);
  expect((await fs.stat(retained)).ino).toBe(inode);
  expect(copy).not.toHaveBeenCalled();
  await fs.unlink(original);
  expect(await fs.readFile(retained, 'utf8')).toBe('completed immutable vectors');
});

it.skipIf(process.platform === 'win32')(
  'retries a failed sync when the embeddings parent already exists',
  async () => {
    const open = fs.open.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (target === destination) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          if (++attempts <= 2)
            throw Object.assign(new Error('Directory sync failed'), { code: 'EIO' });
          await sync();
        });
      }
      return handle;
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        retainSharedVectorArtifact(source, destination, generation),
      ).rejects.toMatchObject({ code: 'EIO' });
    }
    await retainSharedVectorArtifact(source, destination, generation);
    expect(attempts).toBe(3);
    expect(await fs.readFile(retained, 'utf8')).toBe('completed immutable vectors');
  },
);

it.skipIf(process.platform === 'win32').each([false, true])(
  'retries publication sync for an existing artifact (copy=%s)',
  async (copy) => {
    if (copy) vi.spyOn(fs, 'link').mockRejectedValue(differentDevice());
    const copyFile = vi.spyOn(fs, 'copyFile');
    const open = fs.open.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (target === path.dirname(path.dirname(retained))) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          if (
            await fs.stat(retained).then(
              () => true,
              () => false,
            )
          ) {
            if (++attempts <= 2)
              throw Object.assign(new Error('Directory sync failed'), { code: 'EIO' });
          }
          await sync();
        });
      }
      return handle;
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        retainSharedVectorArtifact(source, destination, generation, copy),
      ).rejects.toMatchObject({ code: 'EIO' });
    }
    const inode = (await fs.stat(retained)).ino;
    await retainSharedVectorArtifact(source, destination, generation, copy);
    expect(attempts).toBe(3);
    expect((await fs.stat(retained)).ino).toBe(inode);
    expect(copyFile).toHaveBeenCalledTimes(copy ? 1 : 0);
    expect(await fs.readFile(retained, 'utf8')).toBe(await fs.readFile(original, 'utf8'));
  },
);

it('copies only for explicit initial adoption across filesystems, then reuses the receipt', async () => {
  vi.spyOn(fs, 'link').mockRejectedValue(differentDevice());
  const copy = vi.spyOn(fs, 'copyFile');
  await retainSharedVectorArtifact(source, destination, generation, true);
  expect((await fs.stat(retained)).ino).not.toBe((await fs.stat(original)).ino);
  await retainSharedVectorArtifact(source, destination, generation, true);
  expect(copy).toHaveBeenCalledOnce();
  expect(await fs.readFile(retained, 'utf8')).toBe(await fs.readFile(original, 'utf8'));
});

it('retains its source and refuses an unadmitted cross-device copy', async () => {
  vi.spyOn(fs, 'link').mockRejectedValue(differentDevice());
  const copy = vi.spyOn(fs, 'copyFile');
  await expect(retainSharedVectorArtifact(source, destination, generation)).rejects.toMatchObject({
    code: 'EXDEV',
  });
  expect(copy).not.toHaveBeenCalled();
  expect(await fs.readFile(original, 'utf8')).toBe('completed immutable vectors');
  await expect(fs.stat(retained)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retries a partial initial copy without overwriting its immutable source', async () => {
  vi.spyOn(fs, 'link').mockRejectedValue(differentDevice());
  const copy = vi.spyOn(fs, 'copyFile').mockImplementationOnce(async (_from, to) => {
    await fs.writeFile(to, 'partial');
    throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
  });
  await expect(
    retainSharedVectorArtifact(source, destination, generation, true),
  ).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(await fs.readFile(original, 'utf8')).toBe('completed immutable vectors');
  await retainSharedVectorArtifact(source, destination, generation, true);
  expect(copy).toHaveBeenCalledTimes(2);
  expect(await fs.readFile(retained, 'utf8')).toBe('completed immutable vectors');
});

it('publishes an already durable copy after interruption without copying again', async () => {
  vi.spyOn(fs, 'link').mockRejectedValue(differentDevice());
  const copy = vi.spyOn(fs, 'copyFile');
  const rename = fs.rename;
  let interrupted = false;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (from === preparing && !interrupted) {
      interrupted = true;
      throw new Error('Interrupted before publication');
    }
    return rename(from, to);
  });
  await expect(retainSharedVectorArtifact(source, destination, generation, true)).rejects.toThrow(
    'Interrupted',
  );
  const inode = (await fs.stat(path.join(preparing, 'vectors'))).ino;
  await retainSharedVectorArtifact(source, destination, generation, true);
  expect(copy).toHaveBeenCalledOnce();
  expect((await fs.stat(retained)).ino).toBe(inode);
});

it('does not replace an existing artifact without a matching retention receipt', async () => {
  await fs.mkdir(path.dirname(retained), { recursive: true });
  await fs.writeFile(retained, 'foreign or pending artifact');
  await expect(retainSharedVectorArtifact(source, destination, generation)).rejects.toThrow();
  expect(await fs.readFile(retained, 'utf8')).toBe('foreign or pending artifact');
});

it('rejects an unfinished source without moving its sidecars', async () => {
  await fs.writeFile(original + '.wal', 'pending native writes');
  const link = vi.spyOn(fs, 'link');
  await expect(retainSharedVectorArtifact(source, destination, generation)).rejects.toThrow(
    'unfinished native writes',
  );
  expect(link).not.toHaveBeenCalled();
  expect(await fs.readFile(original + '.wal', 'utf8')).toBe('pending native writes');
});

it('recovers a crash before the first intent record became durable', async () => {
  await fs.mkdir(preparing, { recursive: true });
  await fs.writeFile(
    path.join(preparing, `.retained.json.${randomUUID()}.tmp`),
    'incomplete record',
  );
  await retainSharedVectorArtifact(source, destination, generation);
  expect(await fs.readFile(retained, 'utf8')).toBe('completed immutable vectors');
});

it('retains an unreadable preparation and its files as evidence', async () => {
  await fs.mkdir(preparing, { recursive: true });
  await fs.writeFile(path.join(preparing, 'retained.json'), 'corrupt');
  await fs.writeFile(path.join(preparing, 'vectors'), 'unverified work');
  await expect(retainSharedVectorArtifact(source, destination, generation)).rejects.toThrow();
  expect(await fs.readFile(path.join(preparing, 'vectors'), 'utf8')).toBe('unverified work');
});

it('retains an unacknowledged preparation with unexpected files', async () => {
  await fs.mkdir(preparing, { recursive: true });
  const temporary = path.join(preparing, `.retained.json.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, 'incomplete record');
  await fs.writeFile(path.join(preparing, 'vectors'), 'unverified work');
  await expect(retainSharedVectorArtifact(source, destination, generation)).rejects.toThrow(
    'artifacts retained',
  );
  expect(await fs.readFile(temporary, 'utf8')).toBe('incomplete record');
  expect(await fs.readFile(path.join(preparing, 'vectors'), 'utf8')).toBe('unverified work');
});
