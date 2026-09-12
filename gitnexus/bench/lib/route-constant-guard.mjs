/** Shared fingerprint + --check helpers for route-constant benchmarks. */
import fs from 'node:fs';
import crypto from 'node:crypto';

export function fingerprintIds(ids) {
  return crypto
    .createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
}

/** Min sample for mutating benchmarks that need fresh state per repetition. */
export function minSampleFresh(create, run, warmup, reps) {
  for (let w = 0; w < warmup; w++) run(create());
  const samples = [];
  let last;
  for (let r = 0; r < reps; r++) {
    const state = create();
    const t0 = performance.now();
    last = run(state);
    samples.push(performance.now() - t0);
  }
  return { last, ms: Math.min(...samples) };
}

export function runCountCheck(report, field, expectedCounts) {
  const errors = [];
  for (const [arm, expected] of Object.entries(expectedCounts)) {
    const actual = report[arm]?.[field];
    if (actual !== expected) {
      errors.push(`${arm}.${field} ${String(actual)} != ${expected}`);
    }
  }
  failIfNeeded(report, errors);
}

export function runFingerprintParityCheck(report, leftArm, rightArm) {
  const left = report[leftArm]?.fingerprint;
  const right = report[rightArm]?.fingerprint;
  failIfNeeded(
    report,
    left === right ? [] : [`${leftArm}.fingerprint ${left} != ${rightArm}.fingerprint ${right}`],
  );
}

export function runBaselineCheck(report, baselinePath) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  const errors = [];
  if (report.fingerprint !== baseline.fingerprint) {
    errors.push(`fingerprint drift: ${report.fingerprint} != ${baseline.fingerprint}`);
  }
  if (report.scaling_ratio > baseline.scaling_budget) {
    errors.push(`scaling_ratio ${report.scaling_ratio} > ${baseline.scaling_budget}`);
  }
  if (
    baseline.absolute_ms_budget !== undefined &&
    report.absolute_ms > baseline.absolute_ms_budget
  ) {
    errors.push(`absolute_ms ${report.absolute_ms} > ${baseline.absolute_ms_budget}`);
  }
  if (
    baseline.widening_overhead_budget !== undefined &&
    report.widening_overhead > baseline.widening_overhead_budget
  ) {
    errors.push(
      `widening_overhead ${report.widening_overhead} > ${baseline.widening_overhead_budget}`,
    );
  }
  failIfNeeded(report, errors);
  console.log(JSON.stringify({ ok: true, report }, null, 2));
}

function failIfNeeded(report, errors) {
  if (errors.length === 0) return;
  console.error(JSON.stringify({ report, errors }, null, 2));
  process.exit(1);
}
