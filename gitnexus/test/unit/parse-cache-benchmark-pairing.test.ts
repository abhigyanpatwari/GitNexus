import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

it('measures matching phases consecutively while alternating the first arm', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parse-cache-pairing-'));
  try {
    const output = path.join(root, 'measure.json');
    const dist = fileURLToPath(new URL('../../dist', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../bench/file-result-reuse/benchmark.js', import.meta.url)),
        '--baseline-dist',
        dist,
        '--dist',
        dist,
        '--pairs',
        '2',
        '--files',
        '2',
        '--workers',
        '1',
        '--output',
        output,
      ],
      { encoding: 'utf8', timeout: 90_000 },
    );
    expect(result.status, result.stderr || result.error?.message || result.stdout).toBe(0);
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report.verdict).toBe('smoke-only');
    const phases = ['cold', 'warm', 'edit', 'two-edits', 'repack'];
    for (const [i, pair] of [report.warmup, ...report.pairs].entries()) {
      const order = i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      expect(pair.phaseOrder).toEqual(
        phases.flatMap((phase) => order.map((variant) => ({ phase, variant }))),
      );
      for (const variant of order) {
        expect(pair[variant].measurements.map((row: { kind: string }) => row.kind)).toEqual(phases);
        expect(pair[variant].measurements.map((row: { reparsed: number }) => row.reparsed)).toEqual(
          [2, 0, 1, 2, 0],
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
