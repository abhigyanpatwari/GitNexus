import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quantile } from '../mcp-query/statistics.mjs';

export function assessPairs(pairs) {
  assert(pairs.length >= 8, 'At least eight complete measured pairs are required');
  for (const pair of pairs) {
    assert(
      [pair.baseline, pair.candidate].every((n) => Number.isFinite(n) && n > 0),
      'Invalid or missing timing',
    );
  }
  const ratio = quantile(
    pairs.map((p) => p.candidate / p.baseline),
    0.5,
  );
  const baselineMedian = quantile(
    pairs.map((p) => p.baseline),
    0.5,
  );
  const candidateMedian = quantile(
    pairs.map((p) => p.candidate),
    0.5,
  );
  const medianRatio = candidateMedian / baselineMedian;
  return {
    baselineMedian,
    candidateMedian,
    medianRatio,
    pairedMedianRatio: ratio,
    verdict: Math.max(ratio, medianRatio) > 1.05 ? 'regression' : 'within-budget',
  };
}

export function indexingMetrics(report, lifecycle) {
  assert.equal(report.lifecycle, lifecycle);
  assert.equal(report.screen, false, 'Screened runs cannot pass the performance gate');
  assert(Number.isSafeInteger(report.pairs) && report.pairs >= 9, 'Missing measured pairs');
  assert.equal(report.results.length, 2 * (report.pairs + 1), 'Incomplete indexing run');
  const byName = new Map(report.results.map((r) => [r.name, r]));
  assert.equal(byName.size, report.results.length, 'Duplicate indexing sample');
  assert(byName.has('baseline-seed') && byName.has('candidate-seed'), 'Missing seeds');
  const pairs = [];
  for (let i = 1; i <= report.pairs; i++) {
    const baseline = byName.get('baseline-' + i);
    const candidate = byName.get('candidate-' + i);
    for (const [variant, sample] of Object.entries({ baseline, candidate })) {
      assert.equal(sample?.variant, variant, 'Missing or mislabeled indexing sample');
      assert.equal(sample.incremental?.writeMode, 'incremental');
      assert.equal(sample.incremental?.changedFiles, 1);
      assert.deepEqual(sample.rebuildReasons, []);
      assert(sample.cachedFiles > 0, 'The benchmark must hydrate cached files');
      assert(sample.graph?.nodes?.count > 0 && sample.graph?.edges?.count > 0);
      assert.deepEqual(sample.persistedTargets, [{ target: i % 2 ? 'load' : 'save' }]);
    }
    assert.deepEqual(candidate.graph, baseline.graph, 'Semantic graph differs');
    if (i > 1) pairs.push({ baseline, candidate });
  }
  return ['ms', 'cpuMs'].map((key) => ({
    name: lifecycle + '/' + key,
    ...assessPairs(pairs.map((p) => ({ baseline: p.baseline[key], candidate: p.candidate[key] }))),
  }));
}

export function interningMetrics(report) {
  assert.equal(report.equivalent, true, 'Shard equivalence was not verified');
  assert(report.shards > 0 && report.bytes > 0 && report.strings > 0, 'Empty corpus');
  assert.equal(report.warmupRounds, 2);
  assert.equal(report.samples.length, 20, 'Incomplete interning run');
  const byName = new Map(report.samples.map((r) => [r.variant + '/' + r.round, r]));
  assert.equal(byName.size, 20, 'Duplicate interning sample');
  const pairs = [];
  for (let round = 0; round < 10; round++) {
    const baseline = byName.get('baseline/' + round);
    const candidate = byName.get('candidate/' + round);
    assert(baseline && candidate, 'Missing interning sample');
    if (round >= 2) pairs.push({ baseline, candidate });
  }
  return ['ms', 'cpuMs', 'hydrateCpuMs'].map((key) => ({
    name: key === 'hydrateCpuMs' ? 'deserialize+intern/cpuMs' : 'intern/' + key,
    ...assessPairs(pairs.map((p) => ({ baseline: p.baseline[key], candidate: p.candidate[key] }))),
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  assert(directory, 'Expected benchmark output directory');
  const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const fresh = read('fresh/results.json');
  const persistent = read('persistent/results.json');
  const interning = read('interner.json');
  assert.equal(fresh.head, persistent.head, 'Source revisions differ');
  assert.equal(fresh.head, interning.corpusHead, 'Cache corpus revision differs');
  assert.equal(fresh.node, persistent.node, 'Node versions differ');
  assert.equal(fresh.node, interning.node, 'Interner Node version differs');
  const metrics = [
    ...indexingMetrics(fresh, 'fresh'),
    ...indexingMetrics(persistent, 'persistent'),
    ...interningMetrics(interning),
  ];
  const report = { runtimes: interning.runtimes, corpusHead: fresh.head, metrics };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = [
    '## Cache interning and indexing performance',
    '',
    'Warm-up samples excluded; execution order alternates. Times in ms.',
    '',
    '| Measurement | Base median | Candidate median | Median change | Median paired change | Result |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...metrics.map(
      (m) =>
        '| ' +
        [
          m.name,
          m.baselineMedian.toFixed(1),
          m.candidateMedian.toFixed(1),
          ((m.medianRatio - 1) * 100).toFixed(1) + '%',
          ((m.pairedMedianRatio - 1) * 100).toFixed(1) + '%',
          m.verdict,
        ].join(' | ') +
        ' |',
    ),
    '',
    'A slowdown above 5% in either the overall median or median paired ratio of any timed metric fails. This is a regression budget, not a statistical confidence claim. Persistent pairs share processes. CPU includes GC threads active during the timed work; forced GC between rounds is excluded. Peak RSS is cumulative and descriptive. Shard graph/byte/pool equality and persisted edit targets must match. Incomplete or invalid measurements fail.',
    "Raw hydrateCpuMs measures deserialization plus interning. Raw analysisPeakRssKiB is the process-lifetime RSS high-water mark captured before the current sample's graph verification; earlier samples can set it. It is not an interval peak.",
    '',
  ];
  const markdown = lines.join('\n');
  fs.writeFileSync(path.join(directory, 'report.md'), markdown);
  console.log(markdown);
  if (metrics.some((m) => m.verdict === 'regression')) process.exitCode = 1;
}
