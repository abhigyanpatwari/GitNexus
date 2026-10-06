import { EXPECTATIONS } from './expectations.js';

export interface KnownGap {
  id: string;
  issue: number;
  reason: string;
  baselineActual: string[];
}

export interface KnownGapManifest {
  schemaVersion: 1;
  baselineSourceSha: string;
  gaps: KnownGap[];
}

function compare(expected: string[], actual: string[]) {
  const remaining = [...actual];
  const matched: string[] = [];
  const missing: string[] = [];
  for (const answer of expected) {
    const index = remaining.indexOf(answer);
    if (index === -1) missing.push(answer);
    else {
      matched.push(answer);
      remaining.splice(index, 1);
    }
  }
  return {
    matched,
    missing,
    unexpected: remaining.sort(),
    precision: actual.length ? matched.length / actual.length : expected.length ? 0 : 1,
    recall: expected.length ? matched.length / expected.length : actual.length ? 0 : 1,
  };
}

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);

/** Missing/malformed observations can never be accepted by a known-gap allowance. */
export function scoreAccuracy(
  observations: Record<string, unknown>,
  manifest: KnownGapManifest,
  source: { sha: string; dirty: boolean; fixtureSha: string },
  executionErrors: string[] = [],
) {
  const errors = [...executionErrors];
  const expectations = new Map(EXPECTATIONS.map((entry) => [entry.id, entry]));
  const gaps = new Map<string, KnownGap>();
  if (!/^[0-9a-f]{40}$/.test(source.sha)) errors.push('Missing or malformed source SHA');
  if (!/^[0-9a-f]{64}$/.test(source.fixtureSha)) errors.push('Missing or malformed fixture SHA');
  if (
    manifest?.schemaVersion !== 1 ||
    !/^[0-9a-f]{40}$/.test(manifest?.baselineSourceSha ?? '') ||
    !Array.isArray(manifest?.gaps)
  ) {
    errors.push('Malformed known-gap manifest');
  } else {
    for (const gap of manifest.gaps) {
      const entry = expectations.get(gap?.id);
      if (
        !entry ||
        gap.issue !== entry.issue ||
        typeof gap.reason !== 'string' ||
        !gap.reason.trim() ||
        !stringArray(gap.baselineActual)
      ) {
        errors.push(`Malformed or unknown known-gap entry: ${gap?.id}`);
        continue;
      }
      if (gaps.has(gap.id)) errors.push(`Duplicate known-gap entry: ${gap.id}`);
      const baseline = compare(entry.expected, gap.baselineActual);
      if (!baseline.missing.length && !baseline.unexpected.length)
        errors.push(`Known-gap baseline already passes: ${gap.id}`);
      gaps.set(gap.id, gap);
    }
  }
  for (const id of Object.keys(observations)) {
    if (!expectations.has(id)) errors.push(`Unknown observation: ${id}`);
  }
  const unexpectedFailures: string[] = [];
  const staleAllowances: string[] = [];
  const cases = EXPECTATIONS.map((entry) => {
    const observed = observations[entry.id];
    const valid = stringArray(observed);
    if (!valid) errors.push(`Missing or malformed observation: ${entry.id}`);
    const actual = valid ? [...observed].sort() : [];
    const measurement = compare(entry.expected, actual);
    const passed = valid && !measurement.missing.length && !measurement.unexpected.length;
    const gap = gaps.get(entry.id);
    let status: 'pass' | 'known-gap' | 'regression' = passed ? 'pass' : 'regression';
    if (passed && gap) staleAllowances.push(entry.id);
    if (!passed && gap && valid) {
      const baseline = compare(entry.expected, gap.baselineActual);
      // Allow partial repairs, while rejecting lost correct facts or new wrong facts
      // even inside an existing failing check. Multisets retain duplicate answers.
      const lostCorrect = compare(baseline.matched, measurement.matched).missing;
      const newWrong = compare(baseline.unexpected, measurement.unexpected).unexpected;
      if (!lostCorrect.length && !newWrong.length) status = 'known-gap';
    }
    if (status === 'regression') unexpectedFailures.push(entry.id);
    return {
      ...entry,
      actual,
      ...measurement,
      passed,
      status,
      ...(gap ? { knownGapReason: gap.reason } : {}),
    };
  });
  const passed = cases.filter((entry) => entry.passed).length;
  return {
    schemaVersion: 1,
    suite: 'tool-accuracy',
    source,
    issueIds: [...new Set(EXPECTATIONS.map((entry) => entry.issue))].sort((a, b) => a - b),
    summary: {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      accuracy: passed / cases.length,
    },
    gate: {
      passed: !errors.length && !unexpectedFailures.length && !staleAllowances.length,
      errors,
      unexpectedFailures,
      staleAllowances,
    },
    cases,
  };
}

export type AccuracyReport = ReturnType<typeof scoreAccuracy>;

export function formatAccuracyMarkdown(report: AccuracyReport): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Deterministic tool accuracy',
    '',
    `Source SHA: \`${report.source.sha}\`${report.source.dirty ? ' (working tree has tracked changes)' : ''}.`,
    `Fixture SHA-256: \`${report.source.fixtureSha}\`.`,
    '',
    `**${report.summary.passed}/${report.summary.total} fixed answers pass (${percent(report.summary.accuracy)}).** ` +
      `${report.summary.failed} fail. Regression gate: **${report.gate.passed ? 'PASS' : 'FAIL'}**.`,
    'The regression gate permits only reviewed initial gaps; it is not a claim of full tool correctness. No network, paid models or embeddings are used.',
    '',
    '| Check | Issue | Status | Precision | Recall |',
    '| --- | --- | --- | ---: | ---: |',
    ...report.cases.map(
      (entry) =>
        `| ${entry.id} | [#${entry.issue}](https://github.com/abhigyanpatwari/GitNexus/issues/${entry.issue}) | ${entry.status} | ${percent(entry.precision)} | ${percent(entry.recall)} |`,
    ),
    '',
    '## Failed fixed answers',
    '',
    ...report.cases
      .filter((entry) => !entry.passed)
      .map(
        (entry) =>
          `- **${entry.id}**: ${cell(entry.title)}. Expected \`${cell(JSON.stringify(entry.expected))}\`; actual \`${cell(JSON.stringify(entry.actual))}\`.`,
      ),
  ];
  if (report.gate.errors.length)
    lines.push(
      '',
      '## Execution / output errors',
      '',
      ...report.gate.errors.map((error) => `- ${cell(error)}`),
    );
  if (report.gate.unexpectedFailures.length)
    lines.push('', `New or worsened failures: ${report.gate.unexpectedFailures.join(', ')}.`);
  if (report.gate.staleAllowances.length)
    lines.push(
      '',
      `Remove repaired allowances in this PR: ${report.gate.staleAllowances.join(', ')}.`,
    );
  return `${lines.join('\n')}\n`;
}
