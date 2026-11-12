import { describe, expect, it } from 'vitest';

const benchmark = new URL('../../bench/file-result-reuse/benchmark.js', import.meta.url);
const { assessComparison } = await import(benchmark.href);

function report() {
  const trial = () => ({
    provenance: {
      phaseIsolation: 'process',
      execArgv: [
        '--expose-gc',
        '--predictable',
        '--predictable-gc-schedule',
        '--max-old-space-size=4096',
      ],
      sourceDigest: '1'.repeat(64),
      sourceFiles: 1024,
      driverDigest: '2'.repeat(64),
      buildDigest: '3'.repeat(64),
      runtimeHead: '4'.repeat(40),
      node: process.version,
      workers: 2,
      platform: process.platform,
      arch: process.arch,
    },
    measurements: ['cold', 'warm', 'edit', 'two-edits', 'repack'].map((kind, i) => ({
      kind,
      pipelineMs: 90,
      withSaveMs: 100,
      peakRssKb: 1024,
      cacheBytes: 4096,
      cacheFiles: 4,
      cacheFormat: 'per-file',
      nodes: [100, 100, 101, 103, 103][i],
      edges: [200, 200, 201, 203, 203][i],
      parsedNodes: [100, 100, 101, 103, 103][i],
      parsedEdges: [200, 200, 201, 203, 203][i],
      digest: ['a', 'a', 'b', 'c', 'c'][i].repeat(64),
      parsedDigest: ['a', 'a', 'b', 'c', 'c'][i].repeat(64),
      reparsed: [1024, 0, 1, 2, 0][i],
      hits: [0, 1024, 1023, 1022, 1024][i],
      workersStarted: [true, false, true, true, false][i],
    })),
  });
  const pair = (iteration: number) => ({
    iteration,
    order: (iteration + 1) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'],
    baseline: trial(),
    candidate: trial(),
  });
  return {
    schemaVersion: 4,
    warmup: pair(-1),
    pairs: Array.from({ length: 7 }, (_, i) => pair(i)),
  };
}

describe('parse-cache performance acceptance', () => {
  it('keeps every phase, memory and cache-size gate at the five-percent budget', () => {
    const result = assessComparison(report());
    expect(result.passed).toBe(true);
    expect(
      result.metrics.map((m: { name: string; limit: number; passed: boolean }) => [
        m.name,
        m.limit,
        m.passed,
      ]),
    ).toEqual([
      ['repeated analyses', 1.05, true],
      ['peak process RSS', 1.05, true],
      ['cold', 1.05, true],
      ['warm', 1.05, true],
      ['edit', 1.05, true],
      ['two-edits', 1.05, true],
      ['repack', 1.05, true],
      ['cold cache size', 1.05, true],
    ]);
  });

  it('rejects a six-percent slowdown in every timed phase', () => {
    const input = report();
    for (const pair of input.pairs)
      for (const row of pair.candidate.measurements) row.withSaveMs = 106;
    const result = assessComparison(input);
    expect(result.passed).toBe(false);
    expect(result.metrics.map((m: { passed: boolean }) => m.passed)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('fails noisy evidence even when the candidate median equals baseline', () => {
    const input = report();
    input.pairs.forEach((pair, i) => {
      for (const row of pair.candidate.measurements) {
        row.pipelineMs = 70;
        row.withSaveMs = [80, 90, 95, 100, 105, 110, 120][i];
      }
    });
    const result = assessComparison(input);
    expect(result.metrics[0].candidateMedianMs).toBe(400);
    expect(result.metrics[0].baselineMedianMs).toBe(400);
    expect(result.passed).toBe(false);
  });

  it.each(['peakRssKb', 'cacheBytes'] as const)('rejects a six-percent increase in %s', (key) => {
    const input = report();
    for (const pair of input.pairs) for (const row of pair.candidate.measurements) row[key] *= 1.06;
    const result = assessComparison(input);
    expect(result.passed).toBe(false);
    expect(
      result.metrics
        .filter((m: { passed: boolean }) => !m.passed)
        .map((m: { name: string }) => m.name),
    ).toEqual([key === 'peakRssKb' ? 'peak process RSS' : 'cold cache size']);
  });

  it.each(['missing-pair', 'wrong-graph', 'lost-reuse', 'wrong-profile'])(
    'rejects invalid evidence: %s',
    (defect) => {
      const input = report();
      if (defect === 'missing-pair') input.pairs.pop();
      if (defect === 'wrong-profile') input.pairs[0].candidate.provenance.execArgv = [];
      if (defect === 'wrong-graph')
        input.pairs[0].candidate.measurements[2].parsedDigest = 'd'.repeat(64);
      if (defect === 'lost-reuse') {
        input.pairs[0].candidate.measurements[2].reparsed = 2;
        input.pairs[0].candidate.measurements[2].hits = 1022;
      }
      expect(() => assessComparison(input)).toThrow();
    },
  );
});
