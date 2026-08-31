import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir } from '../helpers/test-db.js';

type MockWatcher = EventEmitter & {
  add: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

let pendingClose: Promise<void> | undefined;
let releaseClose: (() => void) | undefined;
let lastWatcher: MockWatcher | undefined;

vi.mock('chokidar', () => ({
  watch: () => {
    const emitter = new EventEmitter() as MockWatcher;
    pendingClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    emitter.add = vi.fn();
    emitter.close = vi.fn(async () => {
      await pendingClose;
    });
    lastWatcher = emitter;
    queueMicrotask(() => emitter.emit('ready'));
    return emitter;
  },
}));

import { startWatchFileLoop, type WatchFileLoop } from '../../src/cli/watch.js';
import { StreamedIncrementalWritebackError } from '../../src/core/run-analyze.js';

const tempDirs: string[] = [];
const loops: WatchFileLoop[] = [];

async function makeRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-shutdown-'));
  tempDirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

afterEach(async () => {
  releaseClose?.();
  await Promise.all(loops.splice(0).map((loop) => loop.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
  pendingClose = undefined;
  releaseClose = undefined;
  lastWatcher = undefined;
});

describe('watch loop fatal shutdown', () => {
  it('does not start another refresh while a slow watcher.close is in flight', async () => {
    const repo = await makeRepo();
    const refreshCalls: string[][] = [];
    const loop: WatchFileLoop = await startWatchFileLoop(
      repo,
      10,
      async (paths) => {
        refreshCalls.push([...paths]);
        if (paths.length === 0) return;
        throw new StreamedIncrementalWritebackError(['structural']);
      },
      (_error, paths) => {
        if (paths.length === 0) return;
        void loop.close();
      },
    );
    loops.push(loop);

    expect(refreshCalls).toEqual([[]]);
    expect(lastWatcher).toBeDefined();
    lastWatcher.emit('all', 'change', path.join(repo, 'src/a.ts'));

    await vi.waitFor(() => {
      expect(refreshCalls.length).toBe(2);
    });
    expect(lastWatcher.close).toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(refreshCalls).toEqual([[], ['src/a.ts']]);

    releaseClose?.();
    await loop.close();
  });
});
