import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const { assessComparison } = await import(
  new URL('../../bench/file-result-reuse/check.mjs', import.meta.url).href
);
const { sourceDigest } = await import(
  new URL('../../bench/file-result-reuse/provenance.mjs', import.meta.url).href
);
const { graphDigests } = await import(
  new URL('../../bench/file-result-reuse/graph-digests.mjs', import.meta.url).href
);

it('ignores only derived nodes and incident edges in the cross-version fingerprint', () => {
  const graph = (community: string, process: string) => ({
    nodes: [
      { id: 'fn:a', label: 'Function', properties: { name: 'a', filePath: 'a.ts' } },
      { id: 'fn:b', label: 'Function', properties: { name: 'b', filePath: 'b.ts' } },
      { id: community, label: 'Community', properties: { name: 'group' } },
      { id: process, label: 'Process', properties: { name: 'flow' } },
    ],
    relationships: [
      { id: 'calls', type: 'CALLS', sourceId: 'fn:a', targetId: 'fn:b' },
      { id: `member:${community}`, type: 'MEMBER_OF', sourceId: 'fn:a', targetId: community },
      { id: `step:${process}`, type: 'STEP_IN_PROCESS', sourceId: 'fn:b', targetId: process },
      { id: `out:${process}`, type: 'CALLS', sourceId: process, targetId: 'fn:b' },
    ],
  });
  const old = graphDigests(graph('comm_0', 'proc_0_a'));
  const current = graph('comm_abcdef123456', 'proc_fedcba654321_a');
  const hashed = graphDigests(current);
  expect(hashed).toMatchObject({
    nodes: 4,
    edges: 4,
    parsedNodes: 2,
    parsedEdges: 1,
    parsedDigest: old.parsedDigest,
  });
  expect(hashed.digest).not.toBe(old.digest);
  expect(
    graphDigests({
      nodes: [...current.nodes].reverse(),
      relationships: [...current.relationships].reverse(),
    }),
  ).toEqual(hashed);
  current.nodes[0].properties.name = 'changed';
  expect(graphDigests(current).parsedDigest).not.toBe(hashed.parsedDigest);
  current.nodes[0].properties.name = 'a';
  current.relationships[0].targetId = 'fn:a';
  expect(graphDigests(current).parsedDigest).not.toBe(hashed.parsedDigest);
});

it('distinguishes corpora with the same unframed path/content bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-corpus-digest-'));
  try {
    await fs.writeFile(path.join(root, 'a.ts'), 'b.tsZ');
    await fs.writeFile(path.join(root, 'a.tsb.ts'), 'Z');
    await fs.writeFile(path.join(root, 'common.ts'), 'export const value = 1;');
    const first = await sourceDigest(root, ['a.ts', 'common.ts']);
    const second = await sourceDigest(root, ['a.tsb.ts', 'common.ts']);
    expect(first).not.toBe(second);
    expect(await sourceDigest(root, ['a.ts', 'common.ts'])).toBe(first);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
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
    parsedNodes: 1900,
    parsedEdges: 2800,
    parsedDigest: (i < 2 ? 'e' : i === 2 ? 'f' : 'a').repeat(64),
  })),
});
const pair = (iteration: number) => ({
  iteration,
  order: (iteration + 1) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'],
  baseline: trial(false),
  candidate: trial(true),
});
const report = () => ({
  schemaVersion: 2,
  warmup: pair(-1),
  pairs: Array.from({ length: 7 }, (_, i) => pair(i)),
});

describe('per-file parse reuse performance gate', () => {
  it('allows derived ID changes across versions while retaining full-graph reuse checks', () => {
    const data = report();
    for (const p of [data.warmup, ...data.pairs]) {
      for (const row of p.candidate.measurements) {
        row.digest = { cold: 'b', warm: 'b', edit: 'c', 'two-edits': 'd', repack: 'd' }[
          row.kind
        ]!.repeat(64);
      }
    }
    expect(assessComparison(data).passed).toBe(true);
    data.pairs[0].candidate.measurements[1].digest = 'c'.repeat(64);
    expect(() => assessComparison(data)).toThrow('Warm graph changed');
    data.pairs[0].candidate.measurements[1].digest = 'b'.repeat(64);
    data.pairs[0].candidate.measurements[4].digest = 'c'.repeat(64);
    expect(() => assessComparison(data)).toThrow('Repacking changed graph');
  });

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
    ['missing pair', 'Seven measured process pairs are required'],
    ['duplicate pair', 'Duplicate or missing pair'],
    ['wrong order', 'Pair order must alternate'],
    ['different corpus', 'Mismatched sourceDigest'],
    ['different runtime', 'Runtime/corpus changed between trials'],
    ['graph mismatch', 'Graph parsedDigest differs for edit'],
    ['node count mismatch', 'Graph parsedNodes differs for edit'],
    ['edge count mismatch', 'Graph parsedEdges differs for edit'],
    ['missing parsed digest', 'Missing parsed graph digest'],
    ['missing phase', 'Missing/duplicate phase'],
    ['invalid RSS', 'Invalid peakRssKb'],
    ['invalid timing', 'Invalid withSaveMs'],
    ['lost cache hit', 'Per-file reuse regressed'],
    ['missing warmup', 'Missing excluded warmup pair'],
    ['unchanged edit', 'Edit was not observed'],
  ])('rejects %s', (failure, message) => {
    const data = report();
    const p = data.pairs[1];
    const row = p.candidate.measurements[2];
    if (failure === 'missing pair') data.pairs.pop();
    if (failure === 'duplicate pair') p.iteration = 0;
    if (failure === 'wrong order') p.order.reverse();
    if (failure === 'different corpus') p.candidate.provenance.sourceDigest = 'b'.repeat(64);
    if (failure === 'different runtime') p.candidate.provenance.buildDigest = 'c'.repeat(64);
    if (failure === 'graph mismatch') row.parsedDigest = 'b'.repeat(64);
    if (failure === 'node count mismatch') row.parsedNodes++;
    if (failure === 'edge count mismatch') row.parsedEdges++;
    if (failure === 'missing parsed digest') row.parsedDigest = '';
    if (failure === 'missing phase') p.candidate.measurements.pop();
    if (failure === 'invalid RSS') row.peakRssKb = Number.NaN;
    if (failure === 'invalid timing') row.withSaveMs = Number.POSITIVE_INFINITY;
    if (failure === 'lost cache hit') {
      row.reparsed++;
      row.hits--;
    }
    if (failure === 'missing warmup') Object.assign(data, { warmup: null });
    if (failure === 'unchanged edit') row.parsedDigest = p.candidate.measurements[1].parsedDigest;
    expect(() => assessComparison(data)).toThrow(message);
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
