import { describe, expect, it } from 'vitest';

const benchmark = new URL('../../bench/file-result-reuse/benchmark.js', import.meta.url);
const { assessComparison, studentCritical } = await import(benchmark.href);

type Metric = { name: string; limit: number; passed: boolean; regressed: boolean };
type Report = ReturnType<typeof report>;

const phases = ['cold', 'warm', 'edit', 'two-edits', 'repack'];
const armOrder = (iteration: number) =>
  (iteration + 1) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];

/** Identical arms; `candidateMs[i % length]` sets every timed phase of pair `i`. */
function report(pairs = 7, maxPairs = 7, candidateMs = [100]) {
  const trial = (withSaveMs: number) => ({
    provenance: {
      phaseIsolation: 'process',
      execArgv: ['--expose-gc', '--predictable-gc-schedule', '--max-old-space-size=4096'],
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
    measurements: phases.map((kind, i) => ({
      kind,
      pipelineMs: 70,
      withSaveMs,
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
    order: armOrder(iteration),
    phaseOrder: phases.flatMap((phase) =>
      armOrder(iteration).map((variant) => ({ phase, variant })),
    ),
    baseline: trial(100),
    candidate: trial(iteration < 0 ? 100 : candidateMs[iteration % candidateMs.length]),
  });
  return {
    schemaVersion: 6,
    design: { stagePairs: 7, maxPairs },
    warmup: pair(-1),
    pairs: Array.from({ length: pairs }, (_, i) => pair(i)),
  };
}

// Paired ratios averaging 1.00: moderate spread settles within 14 pairs,
// wide spread stays inconclusive through all 21.
const moderateNoise = [94, 106, 97, 103, 95, 105, 100];
const wideNoise = [80, 90, 95, 100, 105, 110, 120];

describe('parse-cache performance acceptance', () => {
  it('keeps every phase, memory and cache-size gate at the five-percent budget', () => {
    const result = assessComparison(report());
    expect(result.passed).toBe(true);
    expect(result.metrics.map((m: Metric) => [m.name, m.limit, m.passed])).toEqual([
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

  it('rejects a six-percent slowdown in every timed phase at the first look', () => {
    const result = assessComparison(report(7, 21, [106]));
    expect([result.verdict, result.look, result.passed]).toEqual(['fail', 1, false]);
    expect(result.metrics.map((m: Metric) => m.regressed)).toEqual([
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('fails noisy evidence even when the candidate median equals baseline', () => {
    const result = assessComparison(report(7, 7, wideNoise));
    expect(result.metrics[0].candidateMedianMs).toBe(400);
    expect(result.metrics[0].baselineMedianMs).toBe(400);
    expect([result.verdict, result.passed]).toEqual(['fail', false]);
  });

  it.each([
    ['peakRssKb', 'peak process RSS'],
    ['cacheBytes', 'cold cache size'],
  ] as const)('rejects a six-percent increase in %s', (key, metric) => {
    const input = report();
    for (const pair of input.pairs) for (const row of pair.candidate.measurements) row[key] *= 1.06;
    const result = assessComparison(input);
    expect(result.passed).toBe(false);
    expect(result.metrics.filter((m: Metric) => !m.passed).map((m: Metric) => m.name)).toEqual([
      metric,
    ]);
  });

  it.each<[string, (input: Report) => void]>([
    ['missing-pair', (input) => input.pairs.pop()],
    ['wrong-order', (input) => input.pairs[0].phaseOrder.reverse()],
    ['wrong-profile', (input) => (input.pairs[0].candidate.provenance.execArgv = [])],
    [
      'wrong-graph',
      (input) => (input.pairs[0].candidate.measurements[2].parsedDigest = 'd'.repeat(64)),
    ],
    [
      'lost-reuse',
      (input) =>
        Object.assign(input.pairs[0].candidate.measurements[2], { reparsed: 2, hits: 1022 }),
    ],
    ['pairs-beyond-the-cap', (input) => (input.design.maxPairs = 6)],
  ])('rejects invalid evidence: %s', (_defect, corrupt) => {
    const input = report();
    corrupt(input);
    expect(() => assessComparison(input)).toThrow();
  });
});

describe('parse-cache sequential looks', () => {
  it.each([
    [1, 0.05, 12.706],
    [6, 0.05, 2.447],
    [13, 0.05, 2.16],
    [20, 0.05, 2.086],
    [30, 0.05, 2.042],
    [6, 0.05 / 3, 3.287],
    [13, 0.05 / 3, 2.746],
    [20, 0.05 / 3, 2.613],
  ])('matches the published Student-t value for %i degrees of freedom at %f', (df, alpha, t) => {
    expect(Number(studentCritical(df, alpha).toFixed(3))).toBe(t);
  });

  it('asks for more pairs instead of deciding on inconclusive evidence', () => {
    const result = assessComparison(report(7, 21, moderateNoise));
    expect([result.verdict, result.look, result.looks, result.passed]).toEqual([
      'continue',
      1,
      3,
      false,
    ]);
  });

  it('passes once added pairs bring every interval within budget', () => {
    const result = assessComparison(report(14, 21, moderateNoise));
    expect([result.verdict, result.look, result.passed]).toEqual(['pass', 2, true]);
  });

  it('splits the five-percent error across looks, so each look is stricter', () => {
    // The same seven pairs pass a single 95% look but not the first of three.
    const single = assessComparison(report(7, 7, moderateNoise));
    const first = assessComparison(report(7, 21, moderateNoise));
    expect([single.verdict, single.confidence]).toEqual(['pass', 0.95]);
    expect([first.verdict, first.confidence]).toEqual(['continue', 1 - 0.05 / 3]);
  });

  it('fails evidence that is still inconclusive at the pair cap', () => {
    expect(assessComparison(report(14, 21, wideNoise)).verdict).toBe('continue');
    const result = assessComparison(report(21, 21, wideNoise));
    expect([result.verdict, result.look, result.passed]).toEqual(['fail', 3, false]);
  });

  it.each([
    ['after a pass', [100]],
    ['after a proven regression', [106]],
  ])('rejects a report that kept sampling %s', (_case, candidateMs) => {
    expect(() => assessComparison(report(14, 21, candidateMs))).toThrow(
      'Sampling continued past a decision',
    );
  });

  it('rejects a report that stopped between looks', () => {
    expect(() => assessComparison(report(8, 21))).toThrow('Pairs must end on a look');
  });
});
