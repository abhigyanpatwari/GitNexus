import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeV8CacheFile } from '../../src/storage/v8-sidecar.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

const checker = new URL('../../bench/v8-sidecar/check.mjs', import.meta.url);
const { interningMetrics } = await import(checker.href);

describe('cache interning sample isolation', () => {
  it.each(['unchanged', 'slower', 'corrupt'] as const)(
    'validates a %s candidate through the real harness',
    async (variant) => {
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
        let candidate = repo;
        if (variant !== 'unchanged') {
          candidate = root;
          const moduleDir = path.join(root, 'gitnexus/dist/storage');
          await mkdir(moduleDir, { recursive: true });
          await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
          const original = pathToFileURL(
            path.join(repo, 'gitnexus/dist/storage/v8-sidecar.js'),
          ).href;
          // Run the real interner, then inject one controlled defect. CPU work
          // is deliberately much larger than this tiny corpus's normal cost;
          // this verifies sensitivity without a near-threshold timing assertion.
          const defect =
            variant === 'corrupt'
              ? "graph.nodes[0].name = 'corrupted';"
              : `const start = process.cpuUsage();
               let used;
               do { used = process.cpuUsage(start); }
               while (used.user + used.system < 20000);`;
          await writeFile(
            path.join(moduleDir, 'v8-sidecar.js'),
            `
          import { internGraphStrings as original } from ${JSON.stringify(original)};
          export function internGraphStrings(graph, pool) {
            original(graph, pool);
            ${defect}
          }
        `,
          );
          initGitRepo(root);
          commitAll(root, 'Seed defective benchmark candidate');
        }
        const output = path.join(root, 'interner.json');
        const result = spawnSync(
          process.execPath,
          [
            '--expose-gc',
            fileURLToPath(new URL('../../bench/v8-sidecar/intern.mjs', import.meta.url)),
            repo,
            candidate,
            indexing,
            output,
          ],
          { timeout: 60_000, encoding: 'utf8' },
        );
        if (variant === 'corrupt') {
          expect(result.status).toBe(1);
          expect(result.stderr).toContain('Interned graphs differ');
          await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
          return;
        }
        expect(result.status, result.stderr || result.error?.message).toBe(0);
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
        }
        // The checker validates every measured timing before returning metrics.
        // Assert the complete metric contract; elapsed times vary by machine.
        const metrics = interningMetrics(report);
        expect(metrics.map((metric: { name: string }) => metric.name)).toEqual([
          'intern/ms',
          'intern/cpuMs',
          'deserialize+intern/cpuMs',
        ]);
        if (variant === 'slower') {
          expect(
            metrics.map((metric: { name: string; verdict: string }) => [
              metric.name,
              metric.verdict,
            ]),
          ).toEqual([
            ['intern/ms', 'regression'],
            ['intern/cpuMs', 'regression'],
            ['deserialize+intern/cpuMs', 'regression'],
          ]);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
