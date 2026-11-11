import { afterEach, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createEmbeddingJobDirectories,
  readEmbeddingJobRecord,
  writeEmbeddingJobRecord,
} from '../../src/storage/embedding-job.js';

const directories: string[] = [];
async function fixture(payload: unknown): Promise<string> {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'gn-receipt-security-')),
  );
  directories.push(directory);
  await writeEmbeddingJobRecord(directory, 'job.json', payload);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('node:fs');
  vi.resetModules();
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

it.skipIf(process.platform === 'win32')(
  'retries failed parent sync for an existing job directory',
  async () => {
    const directory = await fixture({ owned: true });
    const open = fs.open.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (target === directory) {
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
        createEmbeddingJobDirectories(directory, ['embeddings', 'job']),
      ).rejects.toMatchObject({ code: 'EIO' });
    }
    await expect(createEmbeddingJobDirectories(directory, ['embeddings', 'job'])).resolves.toBe(
      path.join(directory, 'embeddings', 'job'),
    );
    expect(attempts).toBe(3);
    expect(await readEmbeddingJobRecord(directory, 'job.json')).toEqual({ owned: true });
  },
);

it.each(['read', 'write'] as const)(
  'rejects a directory redirected during realpath before receipt %s',
  async (operation) => {
    const directory = await fixture({ owned: true });
    const outside = await fixture({ outside: true });
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation((target, options) =>
      realpath(target === directory ? outside : target, options),
    );
    const open = vi.spyOn(fs, 'open');
    await expect(
      operation === 'read'
        ? readEmbeddingJobRecord(directory, 'job.json')
        : writeEmbeddingJobRecord(directory, 'job.json', { overwritten: true }),
    ).rejects.toThrow('directory changed');
    expect(open).not.toHaveBeenCalled();
    expect(await readEmbeddingJobRecord(outside, 'job.json')).toEqual({ outside: true });
  },
);

it.skipIf(process.platform === 'win32')(
  'rejects a receipt replaced by a FIFO without blocking its open',
  async () => {
    const directory = await fixture({ owned: true });
    const file = path.join(directory, 'job.json');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (target === file) {
        await fs.unlink(file);
        execFileSync('mkfifo', [file]);
        // Fail before invoking the blocking syscall on the regressed version.
        if (typeof flags !== 'number' || !(flags & constants.O_NONBLOCK))
          throw new Error('Unsafe blocking open of FIFO');
      }
      return open(target, flags, mode);
    });
    await expect(readEmbeddingJobRecord(directory, 'job.json')).rejects.toThrow('regular file');
  },
);

it('rejects a different regular file at the opened path when O_NOFOLLOW is unavailable', async () => {
  const directory = await fixture({ owned: true });
  const replacement = await fixture({ replacement: true });
  const file = path.join(directory, 'job.json');
  vi.doMock('node:fs', async (original) => {
    const actual = await original<typeof import('node:fs')>();
    return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: undefined } };
  });
  vi.resetModules();
  const { readEmbeddingJobRecord: readWithoutNoFollow } =
    await import('../../src/storage/embedding-job.js');
  const open = fs.open.bind(fs);
  const lstat = fs.lstat.bind(fs);
  let close: ReturnType<typeof vi.spyOn> | undefined;
  let read: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
    const handle = await open(target, flags, mode);
    if (target === file) {
      close = vi.spyOn(handle, 'close');
      read = vi.spyOn(handle, 'read');
      // Model a changed directory entry with real inode stats. Windows cannot
      // rename over an open file, so a rename would fail before testing the guard.
      vi.spyOn(fs, 'lstat').mockImplementation((target, options) =>
        lstat(target === file ? path.join(replacement, 'job.json') : target, options),
      );
    }
    return handle;
  });
  await expect(readWithoutNoFollow(directory, 'job.json')).rejects.toThrow('changed during open');
  expect(close).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')(
  'rejects a symlink swapped in during open when O_NOFOLLOW is unavailable',
  async () => {
    const directory = await fixture({ owned: true });
    const outside = await fixture({ outside: true });
    const file = path.join(directory, 'job.json');
    vi.doMock('node:fs', async (original) => {
      const actual = await original<typeof import('node:fs')>();
      return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: undefined } };
    });
    vi.resetModules();
    const { readEmbeddingJobRecord: readWithoutNoFollow } =
      await import('../../src/storage/embedding-job.js');
    const open = fs.open.bind(fs);
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (target === file) {
        await fs.unlink(file);
        await fs.symlink(path.join(outside, 'job.json'), file);
      }
      const handle = await open(target, flags, mode);
      if (target === file) close = vi.spyOn(handle, 'close');
      return handle;
    });
    await expect(readWithoutNoFollow(directory, 'job.json')).rejects.toThrow('regular file');
    expect(close).toHaveBeenCalledOnce();
  },
);
