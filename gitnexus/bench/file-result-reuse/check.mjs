import assert from 'node:assert/strict';
import { summarizePairs } from '../analyze-resume/measure.mjs';

export const phases = ['cold', 'warm', 'edit', 'two-edits', 'repack'];
const digest = /^[a-f0-9]{64}$/;
const positive = (n) => Number.isFinite(n) && n > 0;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;

export function validatePair(pair) {
  const { baseline, candidate } = pair;
  assert(baseline?.provenance && candidate?.provenance, 'Missing provenance');
  for (const key of [
    'sourceDigest',
    'sourceFiles',
    'driverDigest',
    'node',
    'workers',
    'platform',
    'arch',
  ]) {
    assert.notEqual(baseline.provenance[key], undefined, `Missing ${key}`);
    assert.equal(candidate.provenance[key], baseline.provenance[key], `Mismatched ${key}`);
  }
  const files = baseline.provenance.sourceFiles;
  assert(integer(files) && files >= 2, 'Empty or undersized corpus');
  assert(
    integer(baseline.provenance.workers) && baseline.provenance.workers > 0,
    'Invalid workers',
  );
  for (const trial of [baseline, candidate]) {
    assert(
      ['sourceDigest', 'buildDigest', 'driverDigest'].every((key) =>
        digest.test(trial.provenance[key]),
      ),
      'Invalid digest',
    );
    assert(/^[a-f0-9]{40}$/.test(trial.provenance.runtimeHead), 'Missing runtime revision');
    assert.deepEqual(
      trial.measurements.map((row) => row.kind),
      phases,
      'Missing/duplicate phase',
    );
    const format = trial.measurements[0].cacheFormat;
    assert(['chunk', 'per-file'].includes(format), 'Unknown cache format');
    let peak = 0;
    for (const row of trial.measurements) {
      for (const key of [
        'pipelineMs',
        'withSaveMs',
        'peakRssKb',
        'cacheBytes',
        'cacheFiles',
        'nodes',
        'edges',
      ]) {
        assert(positive(row[key]), `Invalid ${key}`);
      }
      assert(row.withSaveMs >= row.pipelineMs, 'Invalid publication timing');
      assert(row.peakRssKb >= peak, 'Invalid process high-water mark');
      peak = row.peakRssKb;
      assert.equal(row.cacheFormat, format, 'Cache format changed within trial');
      assert(
        integer(row.reparsed) && integer(row.hits) && row.reparsed + row.hits === files,
        'Incomplete parsing',
      );
      assert.equal(row.workersStarted, row.reparsed > 0, 'Worker dispatch disagrees with reuse');
      assert(digest.test(row.digest), 'Missing graph digest');
    }
    assert.equal(trial.measurements[0].reparsed, files, 'Cold run must parse every file');
    assert.equal(trial.measurements[1].reparsed, 0, 'Warm run must reuse every file');
    assert.equal(trial.measurements[0].digest, trial.measurements[1].digest, 'Warm graph changed');
    assert.equal(
      trial.measurements[3].digest,
      trial.measurements[4].digest,
      'Repacking changed graph',
    );
    assert.notEqual(
      trial.measurements[1].digest,
      trial.measurements[2].digest,
      'Edit was not observed',
    );
    assert.notEqual(
      trial.measurements[2].digest,
      trial.measurements[3].digest,
      'Second edit was not observed',
    );
  }
  assert.equal(
    candidate.measurements[0].cacheFormat,
    'per-file',
    'Candidate did not use per-file reuse',
  );
  assert.deepEqual(
    candidate.measurements.map((row) => row.reparsed),
    [files, 0, 1, 2, 0],
    'Per-file reuse regressed',
  );
  for (let i = 0; i < phases.length; i++) {
    for (const key of ['digest', 'nodes', 'edges']) {
      assert.equal(
        candidate.measurements[i][key],
        baseline.measurements[i][key],
        `Graph ${key} differs for ${phases[i]}`,
      );
    }
  }
}

export function assessComparison(report) {
  assert.equal(report.schemaVersion, 1, 'Unknown report schema');
  assert(report.pairs.length >= 7, 'Seven measured process pairs are required');
  assert(report.warmup, 'Missing excluded warmup pair');
  const all = [report.warmup, ...report.pairs];
  for (const [index, pair] of all.entries()) {
    assert.equal(pair.iteration, index - 1, 'Duplicate or missing pair');
    assert.deepEqual(
      pair.order,
      index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'],
      'Pair order must alternate',
    );
    validatePair(pair);
    assert(
      pair.baseline.provenance.sourceFiles >= 1024,
      'Acceptance corpus needs at least 1024 files',
    );
    for (const variant of ['baseline', 'candidate']) {
      assert.deepEqual(
        pair[variant].provenance,
        all[0][variant].provenance,
        'Runtime/corpus changed between trials',
      );
      assert.equal(
        pair[variant].measurements[0].cacheFormat,
        all[0][variant].measurements[0].cacheFormat,
        'Cache format changed between trials',
      );
    }
  }
  const improving = report.pairs[0].baseline.measurements[0].cacheFormat === 'chunk';
  const metric = (name, unit, select, limit, strict = false) => {
    const summary = summarizePairs(
      report.pairs.map((pair) => ({
        baseline: select(pair.baseline.measurements),
        candidate: select(pair.candidate.measurements),
      })),
    );
    return {
      name,
      unit,
      limit,
      ...summary,
      passed: strict ? summary.paired95[1] < limit : summary.paired95[1] <= limit,
    };
  };
  const metrics = [
    metric(
      'repeated analyses',
      'ms',
      (rows) => rows.slice(1).reduce((sum, row) => sum + row.withSaveMs, 0),
      improving ? 0.95 : 1.05,
    ),
    metric(
      'peak process RSS',
      'KiB',
      (rows) => Math.max(...rows.map((row) => row.peakRssKb)),
      improving ? 1 : 1.05,
      improving,
    ),
    ...phases.map((phase, i) =>
      metric(phase, 'ms', (rows) => rows[i].withSaveMs, improving ? 1.15 : 1.05),
    ),
    metric('cold cache size', 'bytes', (rows) => rows[0].cacheBytes, improving ? 0.5 : 1.05),
  ];
  return {
    mode: improving ? 'require-improvement' : 'prevent-regression',
    metrics,
    passed: metrics.every((m) => m.passed),
  };
}
