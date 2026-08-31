import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGrepScanInWorker, scanGrepFiles } from '../../src/server/grep-scan.js';

describe('scanGrepFiles', () => {
  it('matches regex lines and respects the path-traversal guard', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-scan-'));
    await fs.writeFile(path.join(dir, 'hit.ts'), 'signOrder()\nnoop\n', 'utf-8');
    const out = await scanGrepFiles({
      repoRoot: dir,
      filePaths: ['hit.ts', '../outside.ts'],
      pattern: 'sign|Sign',
      flags: 'i',
      limit: 10,
      deadlineMs: Date.now() + 5_000,
    });
    expect(out.timedOut).toBe(false);
    expect(out.results).toEqual([{ filePath: 'hit.ts', line: 1, text: 'signOrder()' }]);
  });
});

describe('runGrepScanInWorker', () => {
  it('terminates a catastrophic regex before it blocks the parent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-redos-'));
    // `(a+)+b` against a long run of `a` backtracks; V8 finishes `(a+)+$` instantly.
    await fs.writeFile(path.join(dir, 'bait.ts'), `${'a'.repeat(28)}\n`, 'utf-8');
    let ticks = 0;
    const pulse = setInterval(() => {
      ticks += 1;
    }, 20);
    const started = Date.now();
    try {
      const out = await runGrepScanInWorker({
        repoRoot: dir,
        filePaths: ['bait.ts'],
        pattern: '(a+)+b',
        flags: '',
        limit: 10,
        deadlineMs: Date.now() + 250,
      });
      const elapsed = Date.now() - started;
      expect(out.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(4_000);
      expect(ticks).toBeGreaterThan(3);
    } finally {
      clearInterval(pulse);
    }
  }, 8_000);

  it('returns ordinary matches from the worker', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-ok-'));
    await fs.writeFile(path.join(dir, 'a.ts'), 'console.log("hi")\n', 'utf-8');
    const out = await runGrepScanInWorker({
      repoRoot: dir,
      filePaths: ['a.ts'],
      pattern: 'console\\.log',
      flags: '',
      limit: 10,
      deadlineMs: Date.now() + 5_000,
    });
    expect(out.timedOut).toBe(false);
    expect(out.results).toEqual([{ filePath: 'a.ts', line: 1, text: 'console.log("hi")' }]);
  });
});
