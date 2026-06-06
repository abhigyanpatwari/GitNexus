import type { PrImpactReport, PrImpactSymbolImpactInput } from '../pr-impact/report.js';

export const REGRESSION_FORENSICS_SCHEMA_VERSION = 'regression-forensics.v1alpha1' as const;

export type RegressionForensicsConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RegressionForensicsFailureInput {
  failureCommand: string;
  exitCode: number | 'unknown';
  failingTests: string[];
  failureExcerpt: string;
  environment: {
    label: string;
    os?: string;
    runtime?: string;
  };
}

export interface RegressionForensicsRefsInput {
  knownGoodRef?: string;
  knownBadRef?: string;
}

export interface RegressionForensicsInput {
  failure: RegressionForensicsFailureInput;
  refs: RegressionForensicsRefsInput;
  prImpactReport: PrImpactReport;
}

export interface RegressionForensicsCandidateCause {
  symbol: string;
  file: string;
  confidence: RegressionForensicsConfidence;
  reason: string;
  evidence: string[];
}

export interface RegressionForensicsReport {
  schema_version: typeof REGRESSION_FORENSICS_SCHEMA_VERSION;
  confidence: RegressionForensicsConfidence;
  recommendation: string;
  failure: {
    failure_command: string;
    exit_code: number | 'unknown';
    failing_tests: string[];
    failure_excerpt: string;
    environment: RegressionForensicsFailureInput['environment'];
  };
  refs: {
    known_good_ref?: string;
    known_bad_ref?: string;
  };
  pr_impact: {
    schema_version: string;
    verdict: string;
    files_changed: number;
    mapped_symbols: number;
    test_signal: string;
  };
  candidate_causes: RegressionForensicsCandidateCause[];
  caveats: string[];
}

const highRisk = new Set(['HIGH', 'CRITICAL']);

const causeConfidence = (impact: PrImpactSymbolImpactInput): RegressionForensicsConfidence => {
  if (highRisk.has(impact.risk) && impact.direct > 0) return 'HIGH';
  if (impact.direct > 0 || impact.processesAffected > 0) return 'MEDIUM';
  return 'LOW';
};

const confidenceRank: Record<RegressionForensicsConfidence, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

const minConfidence = (
  a: RegressionForensicsConfidence,
  b: RegressionForensicsConfidence,
): RegressionForensicsConfidence => (confidenceRank[a] <= confidenceRank[b] ? a : b);

const findSymbolFile = (input: RegressionForensicsInput, impact: PrImpactSymbolImpactInput): string => {
  const symbol = input.prImpactReport.mapped_symbols.find(
    (candidate) => candidate.id === impact.symbolId || candidate.name === impact.symbolName,
  );
  return symbol?.filePath ?? 'unknown';
};

const buildCandidateCauses = (
  input: RegressionForensicsInput,
): RegressionForensicsCandidateCause[] =>
  input.prImpactReport.impacts.map((impact) => ({
    symbol: impact.symbolName,
    file: findSymbolFile(input, impact),
    confidence: causeConfidence(impact),
    reason: highRisk.has(impact.risk)
      ? 'High-risk changed symbol is linked to the failing surface.'
      : 'Changed symbol is linked to the failing surface.',
    evidence: [
      `PR Impact verdict: ${input.prImpactReport.verdict}`,
      `Risk: ${impact.risk}`,
      `Direct dependents: ${impact.direct}`,
      `Processes affected: ${impact.processesAffected}`,
      `Test reference: ${impact.testReference}`,
    ],
  }));

const computeConfidence = (
  input: RegressionForensicsInput,
  causes: RegressionForensicsCandidateCause[],
): RegressionForensicsConfidence => {
  if (input.prImpactReport.graph.freshness !== 'fresh') return 'LOW';

  const strongestCause = causes.reduce<RegressionForensicsConfidence>(
    (best, cause) =>
      confidenceRank[cause.confidence] > confidenceRank[best] ? cause.confidence : best,
    'LOW',
  );

  let confidence =
    input.prImpactReport.verdict === 'BLOCK' || input.prImpactReport.verdict === 'NEEDS_DISCUSSION'
      ? strongestCause
      : 'LOW';

  if (!input.refs.knownGoodRef) confidence = minConfidence(confidence, 'MEDIUM');
  if (input.failure.failingTests.length === 0) confidence = minConfidence(confidence, 'MEDIUM');

  return confidence;
};

const recommendationFor = (confidence: RegressionForensicsConfidence): string => {
  if (confidence === 'HIGH') {
    return 'Prioritize the candidate causes before retrying the failing command.';
  }
  if (confidence === 'MEDIUM') {
    return 'Investigate candidate causes before retrying the failing command.';
  }
  return 'Gather stronger failure and graph evidence before making a causal claim.';
};

const buildCaveats = (input: RegressionForensicsInput): string[] => {
  const caveats: string[] = [];

  if (!input.refs.knownGoodRef) {
    caveats.push('No known-good ref was provided; confidence is capped below HIGH.');
  }
  if (input.failure.failingTests.length === 0) {
    caveats.push('No failing test names were provided; failure localization is weaker.');
  }
  if (input.prImpactReport.graph.freshness !== 'fresh') {
    caveats.push('PR Impact graph evidence is stale; causal confidence is limited.');
  }

  caveats.push(...input.prImpactReport.caveats);
  caveats.push('Report identifies candidate causes, not a proven root cause.');

  return Array.from(new Set(caveats));
};

export const buildRegressionForensicsReport = (
  input: RegressionForensicsInput,
): RegressionForensicsReport => {
  const candidateCauses = buildCandidateCauses(input);
  const confidence = computeConfidence(input, candidateCauses);

  return {
    schema_version: REGRESSION_FORENSICS_SCHEMA_VERSION,
    confidence,
    recommendation: recommendationFor(confidence),
    failure: {
      failure_command: input.failure.failureCommand,
      exit_code: input.failure.exitCode,
      failing_tests: input.failure.failingTests,
      failure_excerpt: input.failure.failureExcerpt,
      environment: input.failure.environment,
    },
    refs: {
      known_good_ref: input.refs.knownGoodRef,
      known_bad_ref: input.refs.knownBadRef,
    },
    pr_impact: {
      schema_version: input.prImpactReport.schema_version,
      verdict: input.prImpactReport.verdict,
      files_changed: input.prImpactReport.summary.files_changed,
      mapped_symbols: input.prImpactReport.summary.mapped_symbols,
      test_signal: input.prImpactReport.test_signal.status,
    },
    candidate_causes: candidateCauses,
    caveats: buildCaveats(input),
  };
};

const envLabel = (environment: RegressionForensicsFailureInput['environment']): string => {
  const details = [environment.os, environment.runtime].filter(Boolean).join(', ');
  return details ? `${environment.label} (${details})` : environment.label;
};

const pushTable = (lines: string[], headers: string[], rows: string[][]): void => {
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
};

export const renderRegressionForensicsMarkdown = (
  report: RegressionForensicsReport,
): string => {
  const lines: string[] = [
    '# GitNexus Regression Forensics Report',
    '',
    `Confidence: ${report.confidence}`,
    '',
    `Schema: ${report.schema_version}`,
    '',
    `Recommendation: ${report.recommendation}`,
    '',
    '## Failure Evidence',
    '',
    `- Command: \`${report.failure.failure_command}\``,
    `- Exit code: ${report.failure.exit_code}`,
    `- Environment: ${envLabel(report.failure.environment)}`,
    `- Known good ref: ${report.refs.known_good_ref ? `\`${report.refs.known_good_ref}\`` : 'not provided'}`,
    `- Known bad ref: ${report.refs.known_bad_ref ? `\`${report.refs.known_bad_ref}\`` : 'not provided'}`,
  ];

  if (report.failure.failing_tests.length > 0) {
    lines.push('', '## Failing Tests', '');
    for (const testName of report.failure.failing_tests) lines.push(`- ${testName}`);
  }

  if (report.failure.failure_excerpt) {
    lines.push('', '## Failure Excerpt', '', '```text', report.failure.failure_excerpt, '```');
  }

  lines.push(
    '',
    '## PR Impact Linkage',
    '',
    `- Schema: ${report.pr_impact.schema_version}`,
    `- Verdict: ${report.pr_impact.verdict}`,
    `- Files changed: ${report.pr_impact.files_changed}`,
    `- Mapped symbols: ${report.pr_impact.mapped_symbols}`,
    `- Test signal: ${report.pr_impact.test_signal}`,
  );

  if (report.candidate_causes.length > 0) {
    lines.push('', '## Candidate Causes', '');
    pushTable(
      lines,
      ['Symbol', 'File', 'Confidence', 'Reason'],
      report.candidate_causes.map((cause) => [
        `\`${cause.symbol}\``,
        `\`${cause.file}\``,
        cause.confidence,
        cause.reason,
      ]),
    );

    lines.push('', '## Evidence', '');
    for (const cause of report.candidate_causes) {
      lines.push(`- ${cause.symbol}: ${cause.evidence.join('; ')}`);
    }
  }

  if (report.caveats.length > 0) {
    lines.push('', '## Caveats', '');
    for (const caveat of report.caveats) lines.push(`- ${caveat}`);
  }

  return lines.join('\n');
};
