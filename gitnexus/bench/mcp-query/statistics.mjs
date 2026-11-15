import assert from 'node:assert/strict';

export function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lo = Math.floor(position);
  return sorted[lo] + (sorted[Math.ceil(position)] - sorted[lo]) * (position - lo);
}

/** Resample whole process pairs: requests in one process are not independent. */
export function compare(samples, { relative = 0.05, absolute = 5 } = {}) {
  assert(samples.length > 0, 'Missing measurements');
  const groups = new Map();
  for (const row of samples) {
    assert(Number.isInteger(row.session) && row.session >= 0, 'Invalid session');
    assert(
      [row.baseline, row.candidate].every((n) => Number.isFinite(n) && n > 0),
      'Invalid measurement',
    );
    if (!groups.has(row.session)) groups.set(row.session, []);
    groups.get(row.session).push(row);
  }
  const clusters = [...groups.values()];
  const estimate = (rows) => ({
    ratio: Math.exp(
      rows.reduce((sum, r) => sum + Math.log(r.candidate / r.baseline), 0) / rows.length,
    ),
    delta: rows.reduce((sum, r) => sum + r.candidate - r.baseline, 0) / rows.length,
  });
  let seed = 3728;
  const random = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32;
  const resampled = Array.from({ length: 10000 }, () =>
    estimate(clusters.flatMap(() => clusters[Math.floor(random() * clusters.length)])),
  );
  const ratioCi95 = [0.025, 0.975].map((p) =>
    quantile(
      resampled.map((r) => r.ratio),
      p,
    ),
  );
  const deltaCi95 = [0.025, 0.975].map((p) =>
    quantile(
      resampled.map((r) => r.delta),
      p,
    ),
  );
  return {
    ...estimate(samples),
    pairs: samples.length,
    sessions: clusters.length,
    baselineMedian: quantile(
      samples.map((r) => r.baseline),
      0.5,
    ),
    candidateMedian: quantile(
      samples.map((r) => r.candidate),
      0.5,
    ),
    baselineP95: quantile(
      samples.map((r) => r.baseline),
      0.95,
    ),
    candidateP95: quantile(
      samples.map((r) => r.candidate),
      0.95,
    ),
    ratioCi95,
    deltaCi95,
    verdict:
      clusters.length < 8
        ? 'insufficient-sessions'
        : ratioCi95[0] > 1 + relative && deltaCi95[0] > absolute
          ? 'regression'
          : ratioCi95[1] <= 1 + relative || deltaCi95[1] <= absolute
            ? 'within-threshold'
            : 'inconclusive',
  };
}

export function summarize(records, sessions, rounds, names) {
  assert(
    [sessions, rounds].every((n) => Number.isInteger(n) && n > 0),
    'Invalid experiment size',
  );
  assert(names.length > 0 && new Set(names).size === names.length, 'Invalid workload list');
  assert.equal(records.length, sessions * rounds, 'Incomplete measurement set');
  const identities = new Set();
  for (const record of records) {
    assert(
      Number.isInteger(record.session) &&
        Number.isInteger(record.round) &&
        record.session >= 0 &&
        record.session < sessions &&
        record.round >= 0 &&
        record.round < rounds,
      'Invalid sample identity',
    );
    const key = `${record.session}/${record.round}`;
    assert(!identities.has(key), 'Duplicate sample');
    identities.add(key);
    for (const variant of ['baseline', 'candidate']) {
      for (const name of names) assert(record[variant][name], `Missing ${variant}/${name}`);
    }
  }
  const metrics = names.map((name) => ({
    name,
    ...compare(
      records.map((r) => ({
        session: r.session,
        baseline: r.baseline[name].ms,
        candidate: r.candidate[name].ms,
      })),
    ),
  }));
  for (const name of ['startup', 'first_query']) {
    metrics.push({
      name,
      ...compare(
        records
          .filter((r) => r.round === 0)
          .map((r) => ({
            session: r.session,
            baseline: r.baseline[name].ms,
            candidate: r.candidate[name].ms,
          })),
      ),
    });
  }
  return metrics;
}

export function formatReport(report) {
  const percent = (r) => `${r >= 1 ? '+' : ''}${((r - 1) * 100).toFixed(1)}%`;
  const table = report.metrics
    .map(
      (r) =>
        `| ${r.name} | ${r.baselineMedian.toFixed(1)} → ${r.candidateMedian.toFixed(1)} | ${r.baselineP95.toFixed(1)} → ${r.candidateP95.toFixed(1)} | ${percent(r.ratio)} (${r.ratioCi95.map(percent).join(' to ')}) | ${r.verdict} |`,
    )
    .join('\n');
  const resources = [
    ['cpuMs', 'Server CPU seconds', 1000],
    ['peakRssKiB', 'Server peak RSS MiB', 1024],
  ]
    .map(
      ([key, label, divisor]) =>
        `| ${label} | ${['baseline', 'candidate']
          .map((variant) =>
            (
              quantile(
                report.finalResources.map((r) => r[variant][key]),
                0.5,
              ) / divisor
            ).toFixed(2),
          )
          .join(' → ')} |`,
    )
    .join('\n');
  const payloads = ['small_source', 'large_source', 'context', 'tools_list']
    .map(
      (name) =>
        `| ${name} | ${['baseline', 'candidate']
          .map((variant) =>
            quantile(
              report.records.map((r) => r[variant][name].bytes),
              0.5,
            ).toFixed(0),
          )
          .join(' → ')} |`,
    )
    .join('\n');
  return `## MCP query performance

Base \`${report.runtimes.baseline.sha}\`; candidate \`${report.runtimes.candidate.sha}\`.

${report.sessions} fresh process pairs × ${report.rounds} rounds. Real MCP stdio, the same source fixture indexed by each runtime, alternating requests. No model calls.

| Workload | Median ms, base → candidate | p95 ms, base → candidate | Paired change (95% interval) | Assessment |
| --- | ---: | ---: | --- | --- |
${table}

| Resource | Median, base → candidate |
| --- | ---: |
${resources}

| Response | Median UTF-8 bytes, base → candidate |
| --- | ---: |
${payloads}

Intervals resample whole process pairs (10,000 draws). The regression threshold is >5% AND >5 ms; only a confirmed regression fails timing. Inconclusive is not proof of no slowdown. p95, CPU and RSS are descriptive. Startup uses fresh processes with warm filesystem caches.

Correctness, source budget, incomplete samples, and request errors always fail. JSON contains every response size, source-character count, backend phase timing, final server CPU/peak RSS, environment and fixture fingerprint; raw.jsonl retains every completed pair. These generated fixtures do not measure agent dollar savings or all repository workloads.
`;
}
