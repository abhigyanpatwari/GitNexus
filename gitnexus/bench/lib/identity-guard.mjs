/**
 * Shared fingerprint + --check for JVM accessor synthesis benches.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

export function fingerprintIds(ids) {
  return crypto
    .createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
}

export function minSample(run, warmup, reps) {
  for (let w = 0; w < warmup; w++) run();
  const samples = [];
  let last;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    last = run();
    samples.push(performance.now() - t0);
  }
  return { last, ms: Math.min(...samples) };
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
    baseline.widening_overhead_budget !== undefined &&
    report.widening_overhead > baseline.widening_overhead_budget
  ) {
    errors.push(
      `widening_overhead ${report.widening_overhead} > ${baseline.widening_overhead_budget}`,
    );
  }
  if (errors.length) {
    console.error(JSON.stringify({ report, errors }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, report }, null, 2));
}
