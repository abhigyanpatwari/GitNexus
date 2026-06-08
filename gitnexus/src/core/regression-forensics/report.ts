import type { ImpactForRangesReport, ImpactForRangesSymbol } from '../pr-impact/impact-for-ranges-report.js';
import type { PrImpactReport, PrImpactSymbolImpactInput } from '../pr-impact/report.js';

export const REGRESSION_FORENSICS_SCHEMA_VERSION = 'regression-forensics.v1alpha1' as const;

export type RegressionForensicsConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type RegressionForensicsEvidenceMode = 'pr-impact' | 'impact-for-ranges';

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

type RegressionForensicsImpactInput =
  | {
      prImpactReport: PrImpactReport;
      impactForRangesReport?: never;
    }
  | {
      prImpactReport?: never;
      impactForRangesReport: ImpactForRangesReport;
    };

export type RegressionForensicsInput = {
  failure: RegressionForensicsFailureInput;
  refs: RegressionForensicsRefsInput;
} & RegressionForensicsImpactInput;

export interface RegressionForensicsCandidateCause {
  symbol: string;
  file: string;
  confidence: RegressionForensicsConfidence;
  reason: string;
  evidence: string[];
}

export interface RegressionForensicsImpactEvidenceSummary {
  evidence_mode: RegressionForensicsEvidenceMode;
  schema_version: string;
  verdict?: string;
  files_changed?: number;
  mapped_symbols: number;
  test_signal?: string;
  input_ranges?: number;
  symbols_with_processes?: number;
  unmatched_ranges?: number;
  affected_processes?: number;
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
  impact_evidence: RegressionForensicsImpactEvidenceSummary;
  candidate_causes: RegressionForensicsCandidateCause[];
  caveats: string[];
}

const highRisk = new Set(['HIGH', 'CRITICAL']);

const confidenceRank: Record<RegressionForensicsConfidence, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

const minConfidence = (
  a: RegressionForensicsConfidence,
  b: RegressionForensicsConfidence,
): RegressionForensicsConfidence => (confidenceRank[a] <= confidenceRank[b] ? a : b);

const isPrImpactInput = (
  input: RegressionForensicsInput,
): input is RegressionForensicsInput & { prImpactReport: PrImpactReport } =>
  'prImpactReport' in input && input.prImpactReport !== undefined;

const causeConfidence = (impact: PrImpactSymbolImpactInput): RegressionForensicsConfidence => {
  if (highRisk.has(impact.risk) && impact.direct > 0) return 'HIGH';
  if (impact.direct > 0 || impact.processesAffected > 0) return 'MEDIUM';
  return 'LOW';
};

const strongestConfidence = (
  causes: RegressionForensicsCandidateCause[],
): RegressionForensicsConfidence =>
  causes.reduce<RegressionForensicsConfidence>(
    (best, cause) =>
      confidenceRank[cause.confidence] > confidenceRank[best] ? cause.confidence : best,
    'LOW',
  );

const findPrImpactSymbolFile = (
  input: RegressionForensicsInput & { prImpactReport: PrImpactReport },
  impact: PrImpactSymbolImpactInput,
): string => {
  const symbol = input.prImpactReport.mapped_symbols.find(
    (candidate) => candidate.id === impact.symbolId || candidate.name === impact.symbolName,
  );
  return symbol?.filePath ?? 'unknown';
};

const buildPrImpactCandidateCauses = (
  input: RegressionForensicsInput & { prImpactReport: PrImpactReport },
): RegressionForensicsCandidateCause[] =>
  input.prImpactReport.impacts.map((impact) => ({
    symbol: impact.symbolName,
    file: findPrImpactSymbolFile(input, impact),
    confidence: causeConfidence(impact),
    reason: highRisk.has(impact.risk)
      ? 'High-risk changed symbol is linked to the failing surface.'
      : 'Changed symbol is linked to the failing surface.',
    evidence: [
      'Evidence mode: pr-impact',
      `PR Impact verdict: ${input.prImpactReport.verdict}`,
      `Risk: ${impact.risk}`,
      `Direct dependents: ${impact.direct}`,
      `Processes affected: ${impact.processesAffected}`,
      `Test reference: ${impact.testReference}`,
    ],
  }));

const formatMatchedRanges = (symbol: ImpactForRangesSymbol): string =>
  symbol.matched_ranges
    .map((range) => `${range.filePath}:${range.startLine}-${range.endLine}`)
    .join(', ');

const buildImpactForRangesCandidateCauses = (
  input: RegressionForensicsInput & { impactForRangesReport: ImpactForRangesReport },
): RegressionForensicsCandidateCause[] => {
  const direct = input.impactForRangesReport.symbols.map((symbol) => ({
    symbol: symbol.name,
    file: symbol.filePath ?? 'unknown',
    confidence: 'MEDIUM' as const,
    reason: 'Explicit-range evidence links the changed symbol to direct process membership.',
    evidence: [
      'Evidence mode: impact-for-ranges',
      `Matched ranges: ${formatMatchedRanges(symbol) || 'none reported'}`,
      `Direct processes: ${(symbol.processes ?? []).map((process) => process.name).join(', ') || 'none'}`,
      `Change types: ${symbol.change_types.join(', ') || 'modified'}`,
    ],
  }));

  const unmapped = input.impactForRangesReport.unmapped_symbols.map((symbol) => ({
    symbol: symbol.name,
    file: symbol.filePath ?? 'unknown',
    confidence: 'LOW' as const,
    reason: 'Explicit-range evidence matched the symbol but found no direct process membership.',
    evidence: [
      'Evidence mode: impact-for-ranges',
      `Matched ranges: ${formatMatchedRanges(symbol) || 'none reported'}`,
      `Reason: ${symbol.reason ?? 'No direct process membership found for this symbol'}`,
      `Change types: ${symbol.change_types.join(', ') || 'modified'}`,
    ],
  }));

  return [...direct, ...unmapped];
};

const buildCandidateCauses = (input: RegressionForensicsInput): RegressionForensicsCandidateCause[] =>
  isPrImpactInput(input)
    ? buildPrImpactCandidateCauses(input)
    : buildImpactForRangesCandidateCauses(input as RegressionForensicsInput & {
        impactForRangesReport: ImpactForRangesReport;
      });

const computeConfidence = (
  input: RegressionForensicsInput,
  causes: RegressionForensicsCandidateCause[],
): RegressionForensicsConfidence => {
  if (isPrImpactInput(input)) {
    if (input.prImpactReport.graph.freshness !== 'fresh') return 'LOW';

    const strongestCause = strongestConfidence(causes);
    let confidence =
      input.prImpactReport.verdict === 'BLOCK' || input.prImpactReport.verdict === 'NEEDS_DISCUSSION'
        ? strongestCause
        : 'LOW';

    if (!input.refs.knownGoodRef) confidence = minConfidence(confidence, 'MEDIUM');
    if (input.failure.failingTests.length === 0) confidence = minConfidence(confidence, 'MEDIUM');

    return confidence;
  }

  const impact = input.impactForRangesReport;
  let confidence: RegressionForensicsConfidence =
    impact.summary.symbols_with_processes > 0 && causes.some((cause) => cause.confidence === 'MEDIUM')
      ? 'MEDIUM'
      : 'LOW';

  if (impact.repo.indexed_commit === undefined) confidence = minConfidence(confidence, 'LOW');
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
  return 'Gather stronger failure and impact evidence before making a causal claim.';
};

const buildImpactEvidenceSummary = (
  input: RegressionForensicsInput,
): RegressionForensicsImpactEvidenceSummary =>
  isPrImpactInput(input)
    ? {
        evidence_mode: 'pr-impact',
        schema_version: input.prImpactReport.schema_version,
        verdict: input.prImpactReport.verdict,
        files_changed: input.prImpactReport.summary.files_changed,
        mapped_symbols: input.prImpactReport.summary.mapped_symbols,
        test_signal: input.prImpactReport.test_signal.status,
      }
    : {
        evidence_mode: 'impact-for-ranges',
        schema_version: input.impactForRangesReport.schema_version,
        mapped_symbols: input.impactForRangesReport.summary.matched_symbols,
        input_ranges: input.impactForRangesReport.summary.input_ranges,
        symbols_with_processes: input.impactForRangesReport.summary.symbols_with_processes,
        unmatched_ranges: input.impactForRangesReport.summary.unmatched_ranges,
        affected_processes: input.impactForRangesReport.summary.affected_processes,
      };

const buildCaveats = (input: RegressionForensicsInput): string[] => {
  const caveats: string[] = [];

  if (!input.refs.knownGoodRef) {
    caveats.push('No known-good ref was provided; confidence is capped below HIGH.');
  }
  if (input.failure.failingTests.length === 0) {
    caveats.push('No failing test names were provided; failure localization is weaker.');
  }

  if (isPrImpactInput(input)) {
    if (input.prImpactReport.graph.freshness !== 'fresh') {
      caveats.push('PR Impact graph evidence is stale; causal confidence is limited.');
    }
    caveats.push(...input.prImpactReport.caveats);
  } else {
    const impact = input.impactForRangesReport;
    if (impact.repo.indexed_commit === undefined) {
      caveats.push('Explicit-range evidence does not report an indexed commit; freshness confidence is limited.');
    }
    if (impact.summary.unmatched_ranges > 0) {
      caveats.push(`Explicit-range evidence includes ${impact.summary.unmatched_ranges} unmatched range(s).`);
    }
    if (impact.summary.unknown_symbols > 0) {
      caveats.push(`Explicit-range evidence includes ${impact.summary.unknown_symbols} unknown symbol(s).`);
    }
    if (impact.summary.unmapped_symbols > 0) {
      caveats.push(
        `Explicit-range evidence includes ${impact.summary.unmapped_symbols} matched symbol(s) without direct process membership.`,
      );
    }
    caveats.push(
      'Explicit-range evidence mode does not include classic PR-impact verdicts, API-impact entries, or graph-derived test signal.',
    );
    caveats.push(...impact.caveats);
  }

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
    impact_evidence: buildImpactEvidenceSummary(input),
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
    '## Impact Evidence',
    '',
    `- Evidence mode: ${report.impact_evidence.evidence_mode}`,
    `- Schema: ${report.impact_evidence.schema_version}`,
    `- Mapped symbols: ${report.impact_evidence.mapped_symbols}`,
  );

  if (report.impact_evidence.evidence_mode === 'pr-impact') {
    lines.push(
      `- Verdict: ${report.impact_evidence.verdict ?? 'unknown'}`,
      `- Files changed: ${report.impact_evidence.files_changed ?? 0}`,
      `- Test signal: ${report.impact_evidence.test_signal ?? 'unknown_or_unreferenced'}`,
    );
  } else {
    lines.push(
      `- Input ranges: ${report.impact_evidence.input_ranges ?? 0}`,
      `- Symbols with direct processes: ${report.impact_evidence.symbols_with_processes ?? 0}`,
      `- Unmatched ranges: ${report.impact_evidence.unmatched_ranges ?? 0}`,
      `- Affected processes: ${report.impact_evidence.affected_processes ?? 0}`,
    );
  }

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
