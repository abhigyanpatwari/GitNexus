import assert from 'node:assert/strict';

export function evaluateScaling(rows, metrics) {
  const budget = 1.5;
  assert(rows.length >= 2 && metrics.length > 0, 'Scaling needs sizes and metrics');
  for (const [index, row] of rows.entries()) {
    assert(Number.isFinite(row.size) && row.size > 0, 'Invalid workload size');
    if (index) assert(row.size > rows[index - 1].size, 'Sizes must increase');
    for (const metric of metrics)
      assert(Number.isFinite(row[metric]) && row[metric] > 0, `Invalid ${metric}`);
  }
  const pairs = rows.slice(1).map((row, index) => [rows[index], row]);
  if (rows.length > 2) pairs.push([rows[0], rows.at(-1)]);
  const comparisons = pairs.map(([small, large]) => {
    const inputRatio = large.size / small.size;
    const ratios = Object.fromEntries(
      metrics.map((metric) => [metric, large[metric] / small[metric] / inputRatio]),
    );
    return {
      from: small.size,
      to: large.size,
      inputRatio,
      ratios,
      passed: Object.values(ratios).every((ratio) => ratio <= budget),
    };
  });
  return { budget, comparisons, passed: comparisons.every((row) => row.passed) };
}
