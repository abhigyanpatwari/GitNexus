import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checker = new URL('../../bench/v8-sidecar/check.mjs', import.meta.url);
const { assessPairs, indexingMetrics, interningMetrics } = await import(checker.href);

const indexing = (lifecycle = 'fresh') => ({
  lifecycle,
  screen: false,
  pairs: 9,
  head: 'same-source',
  node: process.version,
  results: Array.from({ length: 10 }, (_, pair) =>
    ['baseline', 'candidate'].map((variant) => ({
      name: variant + '-' + (pair || 'seed'),
      variant,
      ms: variant === 'baseline' ? 100 : 90,
      cpuMs: variant === 'baseline' ? 100 : 90,
      incremental: { writeMode: 'incremental', changedFiles: 1 },
      rebuildReasons: [] as string[],
      cachedFiles: 100,
      graph: { nodes: { count: 3, sha256: 'nodes' }, edges: { count: 2, sha256: 'edges' } },
      persistedTargets: [{ target: pair % 2 ? 'load' : 'save' }],
    })),
  ).flat(),
});

const interning = () => ({
  equivalent: true,
  shards: 2,
  bytes: 1000,
  strings: 10,
  warmupRounds: 2,
  corpusHead: 'same-source',
  node: process.version,
  samples: Array.from({ length: 10 }, (_, round) =>
    ['baseline', 'candidate'].map((variant) => ({
      round,
      variant,
      ms: 100,
      cpuMs: 100,
      hydrateCpuMs: 200,
    })),
  ).flat(),
});

describe('cache interning performance gate', () => {
  it.each([0.7, 1, 1.05, 1.051, 1.2])('enforces the paired 5%% budget (%s)', (ratio) => {
    const pairs = Array.from({ length: 8 }, () => ({ baseline: 100, candidate: 100 * ratio }));
    expect(assessPairs(pairs).verdict).toBe(ratio > 1.05 ? 'regression' : 'within-budget');
  });

  it.each([0, -1, NaN, Infinity, undefined])('rejects invalid timing (%s)', (value) => {
    const pairs = Array.from({ length: 8 }, () => ({ baseline: 100, candidate: value }));
    expect(() => assessPairs(pairs)).toThrow('timing');
  });

  it('rejects a slower overall median even when most paired ratios improve', () => {
    const pairs = [100, 100, 100, 100, 200, 200, 200, 200].map((baseline, i) => ({
      baseline,
      candidate: baseline * (i < 3 ? 2 : 0.9),
    }));
    const result = assessPairs(pairs);
    expect(result.pairedMedianRatio).toBeLessThan(1);
    expect(result.medianRatio).toBeGreaterThan(1.05);
    expect(result.verdict).toBe('regression');
  });

  it('excludes warm-up but keeps every measured pair', () => {
    const report = indexing();
    report.results[1].ms = 10000;
    report.results[3].ms = 10000;
    expect(indexingMetrics(report, 'fresh')[0].candidateMedian).toBe(90);
    report.results
      .filter((r) => r.variant === 'candidate')
      .forEach((r) => {
        r.cpuMs = 120;
      });
    expect(indexingMetrics(report, 'fresh')[1].verdict).toBe('regression');
  });

  it('accepts compact full writes for cached edits without relaxing the performance budget', () => {
    const report = indexing();
    for (const sample of report.results.filter((row) => row.variant === 'candidate')) {
      sample.incremental.writeMode = 'full';
      sample.rebuildReasons = ['escalated-full-write'];
      sample.cpuMs = 120;
    }
    expect(indexingMetrics(report, 'fresh')[1].verdict).toBe('regression');
    report.results[3].cachedFiles = 0;
    expect(() => indexingMetrics(report, 'fresh')).toThrow('hydrate cached files');
  });

  it('rejects cache invalidations even alongside a compact full-write reason', () => {
    const report = indexing();
    report.results[3].incremental.writeMode = 'full';
    report.results[3].rebuildReasons = ['escalated-full-write', 'runner-identity'];
    expect(() => indexingMetrics(report, 'fresh')).toThrow('invalidate the parse cache');
  });

  it.each(['', 'unknown', undefined])('rejects an unrecognized write mode (%s)', (mode) => {
    const report = indexing();
    report.results[3].incremental = { ...report.results[3].incremental, writeMode: mode as string };
    expect(() => indexingMetrics(report, 'fresh')).toThrow();
  });

  it.each(['missing', 'duplicate', 'screened', 'cold', 'wrong-target', 'graph', 'rebuild'])(
    'rejects invalid indexing evidence (%s)',
    (kind) => {
      const report = indexing();
      if (kind === 'missing') report.results.pop();
      if (kind === 'duplicate') report.results[3] = report.results[2];
      if (kind === 'screened') report.screen = true;
      if (kind === 'cold') report.results[3].cachedFiles = 0;
      if (kind === 'wrong-target') report.results[3].persistedTargets = [{ target: 'save' }];
      if (kind === 'graph') report.results[3].graph.edges.sha256 = 'wrong';
      if (kind === 'rebuild') report.results[3].rebuildReasons = ['cache-miss'];
      expect(() => indexingMetrics(report, 'fresh')).toThrow();
    },
  );

  it('requires pair-bound validated projection receipts when graph IDs migrate', () => {
    const report = indexing();
    const candidate = report.results.find((sample) => sample.name === 'candidate-1')!;
    candidate.graph.edges.sha256 = 'full-span-edges';
    expect(() => indexingMetrics(report, 'fresh')).toThrow(/without a parity receipt/);
    const graphParity = Array.from({ length: 10 }, (_, i) => {
      const suffix = i || 'seed';
      const baseline = report.results.find((sample) => sample.name === `baseline-${suffix}`)!;
      const after = report.results.find((sample) => sample.name === `candidate-${suffix}`)!;
      return {
        version: 1,
        mode: i === 1 ? 'point-to-span' : 'exact',
        baselineName: baseline.name,
        candidateName: after.name,
        baseline: structuredClone(baseline.graph),
        candidate: structuredClone(after.graph),
        comparison: structuredClone(baseline.graph),
      };
    });
    expect(() => indexingMetrics({ ...report, graphParity }, 'fresh')).not.toThrow();
    expect(() =>
      indexingMetrics({ ...report, graphParity: graphParity.slice(1) }, 'fresh'),
    ).toThrow(/Incomplete graph parity/);
    const modified = structuredClone(graphParity);
    modified[1].comparison.edges.sha256 = 'invented';
    expect(() => indexingMetrics({ ...report, graphParity: modified }, 'fresh')).toThrow(
      /projection differs/,
    );
    const misbound = structuredClone(graphParity);
    misbound[1].candidate.edges.sha256 = 'other';
    expect(() => indexingMetrics({ ...report, graphParity: misbound }, 'fresh')).toThrow(
      /candidate does not match/,
    );
  });

  it('rejects missing, duplicate, or non-equivalent shard measurements', () => {
    const report = interning();
    expect(interningMetrics(report)).toHaveLength(3);
    expect(() => interningMetrics({ ...report, equivalent: false })).toThrow('equivalence');
    expect(() => interningMetrics({ ...report, samples: report.samples.slice(1) })).toThrow(
      'Incomplete',
    );
    report.samples[1] = report.samples[0];
    expect(() => interningMetrics(report)).toThrow('Duplicate');
  });

  it('fails the CLI on CPU regressions and retains the diagnostic report', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'intern-gate-'));
    try {
      for (const lifecycle of ['fresh', 'persistent']) {
        mkdirSync(path.join(directory, lifecycle));
        const report = indexing(lifecycle);
        if (lifecycle === 'fresh')
          report.results
            .filter((r) => r.variant === 'candidate')
            .forEach((r) => {
              r.cpuMs = 120;
            });
        writeFileSync(path.join(directory, lifecycle, 'results.json'), JSON.stringify(report));
      }
      writeFileSync(path.join(directory, 'interner.json'), JSON.stringify(interning()));
      const result = spawnSync(process.execPath, [fileURLToPath(checker), directory], {
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(1);
      expect(readFileSync(path.join(directory, 'report.md'), 'utf8')).toContain('regression');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
