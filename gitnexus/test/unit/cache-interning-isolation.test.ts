import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeV8CacheFile } from '../../src/storage/v8-sidecar.js';

describe('cache interning sample isolation', () => {
  it('measures every arm in its own process with the same GC profile', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'intern-isolation-'));
    try {
      const storage = path.join(root, 'storage');
      await mkdir(path.join(storage, 'parse-cache'), { recursive: true });
      await writeV8CacheFile(path.join(storage, 'parse-cache/shard.v8'), {
        nodes: Array.from({ length: 100 }, (_, i) => ({ name: `symbol-${i % 10}` })),
      });
      const indexing = path.join(root, 'indexing.json');
      await writeFile(
        indexing,
        JSON.stringify({
          head: 'same-corpus',
          results: [{ name: 'baseline-seed', storagePath: storage }],
        }),
      );
      const repo = fileURLToPath(new URL('../../../', import.meta.url));
      const output = path.join(root, 'interner.json');
      execFileSync(
        process.execPath,
        [
          '--expose-gc',
          fileURLToPath(new URL('../../bench/v8-sidecar/intern.mjs', import.meta.url)),
          repo,
          repo,
          indexing,
          output,
        ],
        { timeout: 60_000, stdio: 'pipe' },
      );
      const report = JSON.parse(await readFile(output, 'utf8'));
      expect(report.equivalent).toBe(true);
      expect(report.samples).toHaveLength(20);
      expect(new Set(report.samples.map((sample: { pid: number }) => sample.pid)).size).toBe(20);
      for (const sample of report.samples) {
        expect(sample.pid).not.toBe(process.pid);
        expect(sample.warmupRounds).toBe(2);
        expect(sample.execArgv).toEqual([
          '--expose-gc',
          '--predictable-gc-schedule',
          '--max-old-space-size=4096',
        ]);
        expect(sample.ms).toBeGreaterThan(0);
        expect(sample.cpuMs).toBeGreaterThan(0);
        expect(sample.hydrateCpuMs).toBeGreaterThan(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
