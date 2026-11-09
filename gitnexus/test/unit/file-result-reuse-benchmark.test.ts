import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const { assessComparison } = await import(
  new URL('../../bench/file-result-reuse/check.mjs', import.meta.url).href
);
const phases = ['cold', 'warm', 'edit', 'two-edits', 'repack'];
const trial = (candidate: boolean) => ({
  provenance: {
    sourceFiles: 1024,
    sourceDigest: 'a'.repeat(64),
    buildDigest: (candidate ? 'b' : 'c').repeat(64),
    driverDigest: 'a'.repeat(64),
    runtimeHead: 'd'.repeat(40),
    node: 'v22.23.3',
    workers: 2,
    platform: 'linux',
    arch: 'x64',
  },
  measurements: phases.map((kind, i) => ({
    kind,
    pipelineMs: candidate ? 50 : 90,
    withSaveMs: candidate ? 60 : 100,
    peakRssKb: candidate ? 800 : 1000,
    cacheBytes: candidate ? 100 : 1000,
    cacheFiles: 4,
    cacheFormat: candidate ? 'per-file' : 'chunk',
    reparsed: (candidate ? [1024, 0, 1, 2, 0] : [1024, 0, 8, 16, 1024])[i],
    hits: 1024 - (candidate ? [1024, 0, 1, 2, 0] : [1024, 0, 8, 16, 1024])[i],
    workersStarted: candidate ? i === 0 || i === 2 || i === 3 : i !== 1,
    nodes: 2000,
    edges: 3000,
    digest: (i < 2 ? 'e' : i === 2 ? 'f' : 'a').repeat(64),
  })),
});
const pair = (iteration: number) => ({
  iteration,
  order: (iteration + 1) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'],
  baseline: trial(false),
  candidate: trial(true),
});
const report = () => ({
  schemaVersion: 1,
  warmup: pair(-1),
  pairs: Array.from({ length: 7 }, (_, i) => pair(i)),
});

describe('per-file parse reuse performance gate', () => {
  it('requires both real speed and RSS improvement against the chunk cache', () => {
    const result = assessComparison(report());
    expect(result.mode).toBe('require-improvement');
    expect(result.passed).toBe(true);
    expect(result.metrics.find((m: { name: string }) => m.name === 'peak process RSS').unit).toBe(
      'KiB',
    );
  });

  it.each(['speed', 'memory'])(
    'fails when %s does not improve despite smaller cache files',
    (metric) => {
      const data = report();
      for (const p of data.pairs)
        for (const row of p.candidate.measurements) {
          if (metric === 'speed') row.withSaveMs = 100;
          else row.peakRssKb = 1000;
        }
      expect(assessComparison(data).passed).toBe(false);
    },
  );

  it('does not hide a cold regression behind faster repeated runs', () => {
    const data = report();
    for (const p of data.pairs) p.candidate.measurements[0].withSaveMs = 120;
    expect(assessComparison(data).passed).toBe(false);
  });

  it('rejects noisy memory evidence whose interval crosses the improvement boundary', () => {
    const data = report();
    data.pairs.forEach((p, i) =>
      p.candidate.measurements.forEach((row) => {
        row.peakRssKb = i % 2 ? 1200 : 700;
      }),
    );
    expect(assessComparison(data).passed).toBe(false);
  });

  it('uses a regression budget once the base already has per-file reuse', () => {
    const data = report();
    for (const p of [data.warmup, ...data.pairs]) p.baseline = structuredClone(p.candidate);
    expect(assessComparison(data)).toMatchObject({ mode: 'prevent-regression', passed: true });
    for (const p of data.pairs)
      p.candidate.measurements.forEach((row) => {
        row.peakRssKb *= 1.1;
      });
    expect(assessComparison(data).passed).toBe(false);
  });

  it('rejects different drivers even when each runtime is consistent across trials', () => {
    const data = report();
    for (const p of [data.warmup, ...data.pairs])
      p.candidate.provenance.driverDigest = 'f'.repeat(64);
    expect(() => assessComparison(data)).toThrow('Mismatched driverDigest');
  });

  it('rejects undersized acceptance corpora even with correct graphs and reuse', () => {
    const data = report();
    for (const p of [data.warmup, ...data.pairs]) {
      for (const t of [p.baseline, p.candidate]) {
        t.provenance.sourceFiles = 2;
        for (const row of t.measurements) {
          row.reparsed = Math.min(row.reparsed, 2);
          row.hits = 2 - row.reparsed;
        }
      }
    }
    expect(() => assessComparison(data)).toThrow('Acceptance corpus needs at least 1024 files');
  });

  it('rejects invalid worker counts even when both runtimes agree', () => {
    const data = report();
    for (const p of [data.warmup, ...data.pairs]) {
      p.baseline.provenance.workers = 0;
      p.candidate.provenance.workers = 0;
    }
    expect(() => assessComparison(data)).toThrow('Invalid workers');
  });

  it.each([
    'missing pair',
    'duplicate pair',
    'wrong order',
    'different corpus',
    'different runtime',
    'graph mismatch',
    'missing phase',
    'invalid RSS',
    'invalid timing',
    'lost cache hit',
    'missing warmup',
    'unchanged edit',
  ])('rejects %s', (failure) => {
    const data = report();
    const p = data.pairs[1];
    const row = p.candidate.measurements[2];
    if (failure === 'missing pair') data.pairs.pop();
    if (failure === 'duplicate pair') p.iteration = 0;
    if (failure === 'wrong order') p.order.reverse();
    if (failure === 'different corpus') p.candidate.provenance.sourceDigest = 'b'.repeat(64);
    if (failure === 'different runtime') p.candidate.provenance.buildDigest = 'c'.repeat(64);
    if (failure === 'graph mismatch') row.digest = 'b'.repeat(64);
    if (failure === 'missing phase') p.candidate.measurements.pop();
    if (failure === 'invalid RSS') row.peakRssKb = Number.NaN;
    if (failure === 'invalid timing') row.withSaveMs = Number.POSITIVE_INFINITY;
    if (failure === 'lost cache hit') {
      row.reparsed++;
      row.hits--;
    }
    if (failure === 'missing warmup') Object.assign(data, { warmup: null });
    if (failure === 'unchanged edit') row.digest = p.candidate.measurements[1].digest;
    expect(() => assessComparison(data)).toThrow();
  });
});

it('CI executes live measurements as a blocking speed and memory gate for both corpora', () => {
  const workflow = load(
    readFileSync(new URL('../../../.github/workflows/ci-tests.yml', import.meta.url), 'utf8'),
  ) as {
    jobs: Record<
      string,
      {
        'continue-on-error'?: boolean;
        strategy: { matrix: { corpus: string[] } };
        steps: Array<{
          run?: string;
          if?: string;
          'continue-on-error'?: boolean;
          uses?: string;
          with?: Record<string, string>;
        }>;
      }
    >;
  };
  const job = workflow.jobs['file-result-reuse-benchmark'];
  expect(job.strategy.matrix.corpus).toEqual(['synthetic', 'real']);
  expect(job['continue-on-error']).toBeUndefined();
  const step = job.steps.find((s) => s.run?.includes('node bench/file-result-reuse/measure.mjs'))!;
  expect(step['continue-on-error']).toBeUndefined();
  expect(step.run).toContain('--check');
  expect(step.run).toContain('--baseline-dist');
  expect(step.run).toContain('--pairs 7');
  expect(step.run).toContain('--output "$RUNNER_TEMP/file-result-reuse/measure.json"');
  expect(job.steps.find((s) => s.uses === './.github/actions/upload-test-artifact')?.if).toBe(
    'always()',
  );
});
