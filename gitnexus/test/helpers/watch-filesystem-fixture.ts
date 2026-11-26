import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WatchFileLoop } from '../../src/cli/analyze-watch.js';
import { cleanupTempDir } from './test-db.js';

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for watcher event after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function createWatchFixture() {
  const tempDirs: string[] = [];
  const loops: WatchFileLoop[] = [];

  async function makeRepo(): Promise<string> {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-fs-'));
    tempDirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    return repo;
  }

  async function cleanup() {
    await Promise.all(loops.splice(0).map((loop) => loop.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
  }

  return { tempDirs, loops, makeRepo, cleanup };
}
