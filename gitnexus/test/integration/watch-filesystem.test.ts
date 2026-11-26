import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_CONFIG_WATCH_PATH, startWatchFileLoop } from '../../src/cli/analyze-watch.js';
import { createWatchFixture, waitFor } from '../helpers/watch-filesystem-fixture.js';

const { tempDirs, loops, makeRepo, cleanup } = createWatchFixture();
afterEach(cleanup);

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

  it('observes root control files even when gitignore excludes them', async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, '.gitignore'), '.gitnexusrc\n', 'utf8');
    const batches: string[][] = [];
    const loop = await startWatchFileLoop(
      repo,
      25,
      async (paths) => {
        batches.push([...paths]);
      },
      (error) => {
        throw error;
      },
    );
    loops.push(loop);

    await fs.writeFile(path.join(repo, '.gitnexusrc'), '{}\n', 'utf8');
    await waitFor(() => batches.flat().includes('.gitnexusrc'));
  });

  it('reloads on edit, atomic replacement and removal of the external GITNEXUS_RC file', async () => {
    const repo = await makeRepo();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-rc-'));
    tempDirs.push(outside);
    const rc = path.join(outside, 'service.json');
    await fs.writeFile(rc, '{}\n', 'utf8');
    await fs.writeFile(path.join(outside, 'unrelated.json'), '{}\n', 'utf8');
    const batches: string[][] = [];
    const loop = await startWatchFileLoop(
      repo,
      25,
      async (paths) => {
        batches.push([...paths]);
      },
      (error) => {
        throw error;
      },
      undefined,
      rc,
    );
    loops.push(loop);
    const configReloads = () =>
      batches.filter((batch) => batch.includes(EXTERNAL_CONFIG_WATCH_PATH)).length;

    await fs.writeFile(rc, '{"skipSkills": true}\n', 'utf8');
    await waitFor(() => configReloads() >= 1);

    // Editor-style save: write a sibling, then rename it over the original.
    const staged = path.join(outside, 'service.json.tmp');
    await fs.writeFile(staged, '{"skipSkills": false}\n', 'utf8');
    await fs.rename(staged, rc);
    await waitFor(() => configReloads() >= 2);

    await fs.rm(rc);
    await waitFor(() => configReloads() >= 3);

    // Siblings of the config file never reach the queue.
    await fs.writeFile(path.join(outside, 'unrelated.json'), '{"x": 1}\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(batches.flat().filter((entry) => entry !== EXTERNAL_CONFIG_WATCH_PATH)).toEqual([]);
  });
});
