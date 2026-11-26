import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('runs disjoint Vitest shards, preserves JSON receipts, learns from blobs, and rejects a missing shard', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-shard-roundtrip-'));
  const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));
  const sequencer = fileURLToPath(new URL('../helpers/perf-sequencer.ts', import.meta.url));
  const reporter = fileURLToPath(
    new URL('../../scripts/shard-timings-reporter.ts', import.meta.url),
  );
  const execution = fileURLToPath(new URL('../../scripts/execution-reporter.ts', import.meta.url));
  const timingFile = path.join(root, '.vitest/timings/coverage.json');
  try {
    mkdirSync(path.dirname(timingFile), { recursive: true });
    writeFileSync(
      timingFile,
      JSON.stringify({
        'serial:a.test.ts': 10000,
        'serial:c.test.ts': 9000,
        'parallel:b.test.ts': 10,
        'parallel:d.test.ts': 10,
      }),
    );
    writeFileSync(
      path.join(root, 'vitest.config.ts'),
      `
      import { defineConfig } from ${JSON.stringify(import.meta.resolve('vitest/config'))};
      import PerfSequencer from ${JSON.stringify(sequencer.replaceAll('\\', '/'))};
      export default defineConfig({ test: {
        sequence: { sequencer: PerfSequencer },
        projects: [
          { extends: true, test: { name: 'serial', include: ['a.test.ts', 'c.test.ts'], fileParallelism: false, sequence: { groupOrder: 1 } } },
          { extends: true, test: { name: 'parallel', include: ['b.test.ts', 'd.test.ts'], sequence: { groupOrder: 2 } } }
        ]
      } });
    `,
    );
    for (const name of ['a', 'b', 'c', 'd']) {
      writeFileSync(
        path.join(root, `${name}.test.ts`),
        `import { test, expect } from ${JSON.stringify(import.meta.resolve('vitest'))}; test('${name}', () => expect(1 + 1).toBe(2));`,
      );
    }
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        [vitest, 'run', '--root', root, '--config', path.join(root, 'vitest.config.ts'), ...args],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 30000,
          env: { ...process.env, GITNEXUS_SHARD_PROFILE: 'coverage', NO_COLOR: '1' },
        },
      );
    const files: string[][] = [];
    for (const index of [1, 2]) {
      const result = run([
        `--shard=${index}/2`,
        '--reporter=blob',
        `--reporter=${execution}`,
        `--outputFile.blob=blobs/${index}.json`,
        `--outputFile.json=receipt-${index}.json`,
        '--maxWorkers=1',
      ]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const receipt = JSON.parse(readFileSync(path.join(root, `receipt-${index}.json`), 'utf8'));
      expect(receipt.executionReason).toBe('passed');
      files.push(receipt.testResults.map((entry: { name: string }) => path.basename(entry.name)));
    }
    expect(files.flat().sort()).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts']);
    expect(files.some((bin) => bin.includes('a.test.ts') && bin.includes('c.test.ts'))).toBe(false);
    const result = run(['--mergeReports=blobs', `--reporter=${reporter}`]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const learned = readFileSync(timingFile, 'utf8');
    const timings = JSON.parse(learned);
    expect(Object.keys(timings).sort()).toEqual([
      'parallel:b.test.ts',
      'parallel:d.test.ts',
      'serial:a.test.ts',
      'serial:c.test.ts',
    ]);
    expect(timings['serial:a.test.ts']).toBeGreaterThanOrEqual(5000);
    expect(timings['serial:a.test.ts']).toBeLessThan(10000);
    rmSync(path.join(root, 'blobs/2.json'));
    const incomplete = run(['--mergeReports=blobs', `--reporter=${reporter}`]);
    expect(incomplete.status).not.toBe(0);
    expect(incomplete.stdout + incomplete.stderr).toContain('Incomplete shard reports');
    expect(readFileSync(timingFile, 'utf8')).toBe(learned);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
