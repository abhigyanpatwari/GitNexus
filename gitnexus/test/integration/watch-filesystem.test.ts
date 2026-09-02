import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWatchFileLoop, type WatchFileLoop } from '../../src/cli/analyze-watch.js';
import { cleanupTempDir } from '../helpers/test-db.js';

const tempDirs: string[] = [];
const loops: WatchFileLoop[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for watcher event');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function makeRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-fs-'));
  tempDirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

afterEach(async () => {
  await Promise.all(loops.splice(0).map((loop) => loop.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

describe('watch filesystem integration', () => {
  it('fails startup and closes the watcher when the initial analysis fails', async () => {
    const repo = await makeRepo();
    const onError = vi.fn();

    await expect(
      startWatchFileLoop(
        repo,
        25,
        async () => {
          throw new Error('initial analysis failed');
        },
        onError,
      ),
    ).rejects.toThrow('initial analysis failed');
    expect(onError).not.toHaveBeenCalled();
  });

  it('never enqueues analyzer-owned .gitnexus writes created by the initial refresh', async () => {
    const repo = await makeRepo();
    const batches: string[][] = [];
    const loop = await startWatchFileLoop(
      repo,
      25,
      async (paths) => {
        batches.push([...paths]);
        if (paths.length === 0) {
          await fs.mkdir(path.join(repo, '.gitnexus'), { recursive: true });
          await fs.writeFile(path.join(repo, '.gitnexus', 'gitnexus.json'), '{}\n', 'utf8');
          await fs.writeFile(path.join(repo, '.gitnexus', 'lbug'), 'index bytes', 'utf8');
        }
      },
      (error) => {
        throw error;
      },
    );
    loops.push(loop);

    await new Promise((resolve) => setTimeout(resolve, 200));
    await loop.waitForIdle();

    expect(batches).toEqual([[]]);
  });

  it('coalesces indexed add/change/rename/delete events and stops cleanly', async () => {
    const repo = await makeRepo();
    const batches: string[][] = [];
    const loop = await startWatchFileLoop(
      repo,
      30,
      async (paths) => batches.push([...paths]),
      (error) => {
        throw error;
      },
    );
    loops.push(loop);
    expect(batches).toEqual([[]]);

    await fs.writeFile(path.join(repo, 'README.md'), '# One', 'utf8');
    await fs.writeFile(path.join(repo, 'src.ts'), 'export const one = 1;', 'utf8');
    await fs.writeFile(path.join(repo, 'src.ts'), 'export const one = 2;', 'utf8');
    await waitFor(() => batches.flat().includes('README.md') && batches.flat().includes('src.ts'));

    await fs.rename(path.join(repo, 'src.ts'), path.join(repo, 'renamed.ts'));
    await waitFor(() => batches.flat().includes('renamed.ts'));
    await fs.rm(path.join(repo, 'renamed.ts'));
    await waitFor(() => batches.flat().filter((entry) => entry === 'renamed.ts').length >= 2);

    expect(batches.flat()).toEqual(expect.arrayContaining(['README.md', 'src.ts', 'renamed.ts']));
    await loop.close();
    loops.pop();
    const countAfterClose = batches.length;
    await fs.writeFile(path.join(repo, 'after-close.ts'), 'export {};', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(batches).toHaveLength(countAfterClose);
  });

  it('queues edits during refresh, recovers after failure, and ignores external symlinks', async () => {
    const repo = await makeRepo();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-outside-'));
    tempDirs.push(outside);
    await fs.symlink(
      outside,
      path.join(repo, 'external'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const successful: string[][] = [];
    const errors: string[][] = [];
    let failNext = false;
    let releaseRefresh: (() => void) | undefined;
    const loop = await startWatchFileLoop(
      repo,
      25,
      async (paths) => {
        if (failNext) {
          failNext = false;
          throw new Error('injected refresh failure');
        }
        successful.push([...paths]);
        if (paths.includes('first.ts')) {
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          });
        }
      },
      (_error, paths) => errors.push([...paths]),
    );
    loops.push(loop);

    await fs.writeFile(path.join(repo, 'first.ts'), 'export const first = 1;', 'utf8');
    await waitFor(() => releaseRefresh !== undefined);
    await fs.writeFile(path.join(repo, 'during.ts'), 'export const during = 1;', 'utf8');
    releaseRefresh!();
    await waitFor(() => successful.flat().includes('during.ts'));

    failNext = true;
    await fs.writeFile(path.join(repo, 'fails.ts'), 'export const fail = 1;', 'utf8');
    await waitFor(() => errors.length === 1);
    await waitFor(() => successful.flat().includes('fails.ts'));
    await fs.writeFile(path.join(repo, 'retry.ts'), 'export const retry = 1;', 'utf8');
    await waitFor(() => successful.flat().includes('retry.ts'));

    const beforeExternal = successful.length + errors.length;
    await fs.writeFile(path.join(outside, 'outside.ts'), 'export const outside = 1;', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(successful.length + errors.length).toBe(beforeExternal);
  });

  it('reloads gitignore rules before processing subsequent file events', async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, '.gitignore'), 'blocked.ts\n', 'utf8');
    const batches: string[][] = [];
    const loop = await startWatchFileLoop(
      repo,
      25,
      async (paths) => batches.push([...paths]),
      (error) => {
        throw error;
      },
    );
    loops.push(loop);

    await fs.writeFile(path.join(repo, 'blocked.ts'), 'export const blocked = 1;', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(batches.flat()).not.toContain('blocked.ts');

    await fs.writeFile(path.join(repo, '.gitignore'), '', 'utf8');
    await waitFor(() => batches.flat().includes('.gitignore'));
    await fs.writeFile(path.join(repo, 'blocked.ts'), 'export const blocked = 2;', 'utf8');
    await waitFor(() => batches.flat().includes('blocked.ts'));
  });

  it('keeps the last valid ignore predicate after an oversized reload and later recovers', async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, '.gitignore'), 'blocked.ts\n', 'utf8');
    const batches: string[][] = [];
    const errors: string[][] = [];
    const loop = await startWatchFileLoop(
      repo,
      25,
      async (paths) => batches.push([...paths]),
      (_error, paths) => errors.push([...paths]),
    );
    loops.push(loop);

    await fs.writeFile(path.join(repo, '.gitignore'), 'x'.repeat(1024 * 1024 + 1), 'utf8');
    await waitFor(() => errors.flat().includes('.gitignore'));
    await waitFor(() => errors.length >= 2);
    await fs.writeFile(path.join(repo, 'other.ts'), 'export const other = 1;', 'utf8');
    await waitFor(() => errors.flat().includes('other.ts'));
    expect(batches.flat()).not.toContain('other.ts');
    await fs.writeFile(path.join(repo, 'blocked.ts'), 'export const blocked = 1;', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(batches.flat()).not.toContain('blocked.ts');

    await fs.writeFile(path.join(repo, '.gitignore'), '', 'utf8');
    await waitFor(() => batches.flat().includes('.gitignore'));
    await fs.writeFile(path.join(repo, 'blocked.ts'), 'export const blocked = 2;', 'utf8');
    await waitFor(() => batches.flat().includes('blocked.ts'));
  });

  it('observes root control files even when gitignore excludes them', async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, '.gitignore'), '.gitnexusrc\n', 'utf8');
    const batches: string[][] = [];
    const loop = await startWatchFileLoop(
      repo,
      25,
      async (paths) => batches.push([...paths]),
      (error) => {
        throw error;
      },
    );
    loops.push(loop);

    await fs.writeFile(path.join(repo, '.gitnexusrc'), '{}\n', 'utf8');
    await waitFor(() => batches.flat().includes('.gitnexusrc'));
  });
});
