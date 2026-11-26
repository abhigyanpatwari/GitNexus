import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { expect } from 'expect';
import { startWatchFileLoop } from '../../../../src/cli/analyze-watch.js';
import { createWatchFixture, waitFor } from '../../../../test/helpers/watch-filesystem-fixture.js';

const { tempDirs, loops, makeRepo, cleanup } = createWatchFixture();
const unexpectedErrors: unknown[] = [];
afterEach(async () => {
  await cleanup();
  expect(unexpectedErrors.splice(0)).toEqual([]);
});

describe('watch filesystem integration', () => {
  it('coalesces indexed add/change/rename/delete events and stops cleanly', async () => {
    const repo = await makeRepo();
    const batches: string[][] = [];
    const loop = await startWatchFileLoop(
      repo,
      30,
      async (paths) => {
        batches.push([...paths]);
      },
      (error) => {
        unexpectedErrors.push(error);
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
      async (paths) => {
        batches.push([...paths]);
      },
      (error) => {
        unexpectedErrors.push(error);
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

  it('reports writes issued the instant a gitignore reload re-arms the watcher', async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, '.gitignore'), 'blocked.ts\n', 'utf8');
    await fs.writeFile(path.join(repo, 'blocked.ts'), 'export const blocked = 1;', 'utf8');
    await fs.writeFile(path.join(repo, 'tracked.ts'), 'export const tracked = 1;', 'utf8');
    const batches: string[][] = [];
    let rewritten = false;
    const loop = await startWatchFileLoop(
      repo,
      25,
      async (paths) => {
        batches.push([...paths]);
        // Writing from inside the refresh puts these rewrites right after the
        // re-arm returns. Polling from the test body instead would leave enough
        // slack for a watcher that is not armed yet to look armed.
        if (paths.includes('.gitignore') && !rewritten) {
          rewritten = true;
          await fs.writeFile(path.join(repo, 'blocked.ts'), 'export const blocked = 2;', 'utf8');
          await fs.writeFile(path.join(repo, 'tracked.ts'), 'export const tracked = 2;', 'utf8');
        }
      },
      (error) => {
        unexpectedErrors.push(error);
      },
    );
    loops.push(loop);

    await fs.writeFile(path.join(repo, '.gitignore'), '', 'utf8');
    await waitFor(
      () => batches.flat().includes('blocked.ts') && batches.flat().includes('tracked.ts'),
    );
  });

  it('keeps the last valid ignore predicate after an oversized reload and later recovers', async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, '.gitignore'), 'blocked.ts\n', 'utf8');
    const batches: string[][] = [];
    const errors: string[][] = [];
    const loop = await startWatchFileLoop(
      repo,
      25,
      async (paths) => {
        batches.push([...paths]);
      },
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
});
