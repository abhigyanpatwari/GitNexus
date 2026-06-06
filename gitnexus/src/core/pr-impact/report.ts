import type {
  PrImpactDeletedSymbol,
  PrImpactMappedSymbol,
  PrImpactNewSymbol,
  PrImpactUnmatchedRange,
} from './diff-mapping.js';

export const PR_IMPACT_SCHEMA_VERSION = 'pr-impact.v1alpha1' as const;

export type PrImpactRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
export type PrImpactVerdict = 'BLOCK' | 'NEEDS_DISCUSSION' | 'PROCEED' | 'UNKNOWN';
export type PrImpactTestReferenceStatus = 'has_test_reference' | 'unknown_or_unreferenced';
export type PrImpactGraphFreshness = 'fresh' | 'stale' | 'ambiguous';

export interface PrImpactDiffInput {
  scope: 'unstaged' | 'staged' | 'all' | 'compare';
  baseRef?: string;
  headRef?: string;
  filesChanged: number;
}

export interface PrImpactGraphInput {
  freshness: PrImpactGraphFreshness;
  indexedCommit?: string;
  currentCommit?: string;
  reason?: string;
}

export interface PrImpactSymbolImpactInput {
  symbolId: string;
  symbolName: string;
  risk: PrImpactRisk;
  direct: number;
  processesAffected: number;
  testReference: PrImpactTestReferenceStatus;
}

export interface PrImpactApiImpactInput {
  route: string;
  risk: Exclude<PrImpactRisk, 'UNKNOWN'>;
  consumers: number;
  mismatches: number;
  criticalMismatch?: boolean;
}

export interface PrImpactReportInput {
  diff: PrImpactDiffInput;
  graph: PrImpactGraphInput;
  mappedSymbols: PrImpactMappedSymbol[];
  unmatchedRanges: PrImpactUnmatchedRange[];
  newSymbols: PrImpactNewSymbol[];
  deletedSymbols: PrImpactDeletedSymbol[];
  impacts: PrImpactSymbolImpactInput[];
  apiImpacts: PrImpactApiImpactInput[];
}

export interface PrImpactReportSummary {
  files_changed: number;
  mapped_symbols: number;
  unmatched_ranges: number;
  deleted_symbols: number;
  new_symbols: number;
  impact_entries: number;
  api_impact_entries: number;
}

export interface PrImpactReport {
  schema_version: typeof PR_IMPACT_SCHEMA_VERSION;
  verdict: PrImpactVerdict;
  diff: PrImpactDiffInput;
  graph: PrImpactGraphInput;
  summary: PrImpactReportSummary;
  mapped_symbols: PrImpactMappedSymbol[];
  unmatched_ranges: PrImpactUnmatchedRange[];
  new_symbols: PrImpactNewSymbol[];
  deleted_symbols: PrImpactDeletedSymbol[];
  impacts: PrImpactSymbolImpactInput[];
  api_impacts: PrImpactApiImpactInput[];
  test_signal: {
    status: PrImpactTestReferenceStatus;
  };
  caveats: string[];
}

const riskRank: Record<PrImpactRisk, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
  UNKNOWN: 0,
};

const hasHighOrCritical = (risk: PrImpactRisk): boolean => riskRank[risk] >= riskRank.HIGH;

const summarizeTestSignal = (
  impacts: PrImpactSymbolImpactInput[],
): PrImpactTestReferenceStatus =>
  impacts.length > 0 && impacts.every((impact) => impact.testReference === 'has_test_reference')
    ? 'has_test_reference'
    : 'unknown_or_unreferenced';

const graphCaveat = (graph: PrImpactGraphInput): string | undefined => {
  if (graph.freshness === 'fresh') {
    return graph.indexedCommit ? `Graph evidence is current for commit ${graph.indexedCommit}.` : undefined;
  }
  const label = graph.freshness === 'stale' ? 'stale' : 'ambiguous';
  return graph.reason ? `Graph evidence is ${label}: ${graph.reason}.` : `Graph evidence is ${label}.`;
};

const computeCaveats = (
  input: PrImpactReportInput,
  testSignal: PrImpactTestReferenceStatus,
): string[] => {
  const caveats: string[] = [];
  const freshnessCaveat = graphCaveat(input.graph);
  if (freshnessCaveat) caveats.push(freshnessCaveat);

  for (const deleted of input.deletedSymbols) {
    if (deleted.inboundCallers > 0) {
      caveats.push(`Deleted symbol \`${deleted.name}\` has ${deleted.inboundCallers} inbound caller(s).`);
    }
  }

  if (input.unmatchedRanges.some((range) => range.riskHint === 'high')) {
    caveats.push('Unmatched high-risk ranges require human review.');
  }

  if (
    input.impacts.some((impact) => hasHighOrCritical(impact.risk)) &&
    testSignal === 'unknown_or_unreferenced'
  ) {
    caveats.push('High-risk impact has no known graph-derived test reference.');
  }

  if (input.apiImpacts.some((api) => api.criticalMismatch || api.risk === 'CRITICAL')) {
    caveats.push('Critical API mismatch evidence is present.');
  }

  return caveats;
};

const computeVerdict = (
  input: PrImpactReportInput,
  testSignal: PrImpactTestReferenceStatus,
): PrImpactVerdict => {
  if (input.graph.freshness !== 'fresh') return 'UNKNOWN';

  if (input.deletedSymbols.some((symbol) => symbol.inboundCallers > 0)) return 'BLOCK';
  if (input.apiImpacts.some((api) => api.criticalMismatch || api.risk === 'CRITICAL')) {
    return 'BLOCK';
  }
  if (
    input.impacts.some((impact) => hasHighOrCritical(impact.risk) && impact.direct > 0) &&
    testSignal === 'unknown_or_unreferenced'
  ) {
    return 'BLOCK';
  }

  if (input.unmatchedRanges.some((range) => range.riskHint === 'high')) {
    return 'NEEDS_DISCUSSION';
  }
  if (input.impacts.some((impact) => impact.direct >= 10 || impact.processesAffected >= 2)) {
    return 'NEEDS_DISCUSSION';
  }
  if (input.apiImpacts.some((api) => api.consumers > 0 && testSignal === 'unknown_or_unreferenced')) {
    return 'NEEDS_DISCUSSION';
  }

  return 'PROCEED';
};

export const buildPrImpactReport = (input: PrImpactReportInput): PrImpactReport => {
  const testSignal = summarizeTestSignal(input.impacts);
  return {
    schema_version: PR_IMPACT_SCHEMA_VERSION,
    verdict: computeVerdict(input, testSignal),
    diff: input.diff,
    graph: input.graph,
    summary: {
      files_changed: input.diff.filesChanged,
      mapped_symbols: input.mappedSymbols.length,
      unmatched_ranges: input.unmatchedRanges.length,
      deleted_symbols: input.deletedSymbols.length,
      new_symbols: input.newSymbols.length,
      impact_entries: input.impacts.length,
      api_impact_entries: input.apiImpacts.length,
    },
    mapped_symbols: input.mappedSymbols,
    unmatched_ranges: input.unmatchedRanges,
    new_symbols: input.newSymbols,
    deleted_symbols: input.deletedSymbols,
    impacts: input.impacts,
    api_impacts: input.apiImpacts,
    test_signal: {
      status: testSignal,
    },
    caveats: computeCaveats(input, testSignal),
  };
};

const diffScope = (diff: PrImpactDiffInput): string => {
  if (diff.scope === 'compare') {
    return `compare ${diff.baseRef ?? '<base>'}..${diff.headRef ?? 'HEAD'}`;
  }
  return diff.scope;
};

const pushTable = (
  lines: string[],
  headers: string[],
  rows: string[][],
  alignRight: Set<string> = new Set(),
): void => {
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map((header) => (alignRight.has(header) ? '---:' : '---')).join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${row.join(' | ')} |`);
  }
};

export const renderPrImpactMarkdown = (report: PrImpactReport): string => {
  const lines: string[] = [
    '# GitNexus PR Impact Report',
    '',
    `Verdict: ${report.verdict}`,
    '',
    `Schema: ${report.schema_version}`,
    '',
    '## Summary',
    '',
    `- Diff scope: ${diffScope(report.diff)}`,
    `- Files changed: ${report.summary.files_changed}`,
    `- Mapped symbols: ${report.summary.mapped_symbols}`,
    `- Unmatched ranges: ${report.summary.unmatched_ranges}`,
    `- Deleted symbols: ${report.summary.deleted_symbols}`,
    `- New or unmapped symbols: ${report.summary.new_symbols}`,
    `- Impact entries: ${report.summary.impact_entries}`,
    `- API impact entries: ${report.summary.api_impact_entries}`,
    `- Test signal: ${report.test_signal.status}`,
  ];

  if (report.mapped_symbols.length > 0) {
    lines.push('', '## Changed Symbols', '');
    pushTable(
      lines,
      ['Symbol', 'Kind', 'File', 'Change'],
      report.mapped_symbols.map((symbol) => [
        `\`${symbol.name}\``,
        symbol.kind,
        `\`${symbol.filePath}\``,
        symbol.changeType,
      ]),
    );
  }

  if (report.unmatched_ranges.length > 0) {
    lines.push('', '## Unmatched Ranges', '');
    pushTable(
      lines,
      ['File', 'Lines', 'Reason'],
      report.unmatched_ranges.map((range) => [
        `\`${range.filePath}\``,
        `${range.startLine}-${range.endLine}`,
        range.reason,
      ]),
    );
  }

  if (report.deleted_symbols.length > 0) {
    lines.push('', '## Deleted Symbols', '');
    pushTable(
      lines,
      ['Symbol', 'Kind', 'File', 'Inbound Callers'],
      report.deleted_symbols.map((symbol) => [
        `\`${symbol.name}\``,
        symbol.kind,
        `\`${symbol.filePath}\``,
        String(symbol.inboundCallers),
      ]),
    );
  }

  if (report.new_symbols.length > 0) {
    lines.push('', '## New Or Unmapped Symbols', '');
    pushTable(
      lines,
      ['Symbol', 'Kind', 'File', 'Reason'],
      report.new_symbols.map((symbol) => [
        `\`${symbol.name}\``,
        symbol.kind,
        `\`${symbol.filePath}\``,
        symbol.reason,
      ]),
    );
  }

  if (report.impacts.length > 0) {
    lines.push('', '## Impact', '');
    pushTable(
      lines,
      ['Symbol', 'Risk', 'Direct', 'Processes', 'Test Reference'],
      report.impacts.map((impact) => [
        `\`${impact.symbolName}\``,
        impact.risk,
        String(impact.direct),
        String(impact.processesAffected),
        impact.testReference,
      ]),
      new Set(['Direct', 'Processes']),
    );
  }

  if (report.api_impacts.length > 0) {
    lines.push('', '## API Impact', '');
    pushTable(
      lines,
      ['Route', 'Risk', 'Consumers', 'Mismatches'],
      report.api_impacts.map((api) => [
        `\`${api.route}\``,
        api.risk,
        String(api.consumers),
        String(api.mismatches),
      ]),
      new Set(['Consumers', 'Mismatches']),
    );
  }

  if (report.caveats.length > 0) {
    lines.push('', '## Caveats', '');
    for (const caveat of report.caveats) {
      lines.push(`- ${caveat}`);
    }
  }

  return lines.join('\n').trim();
};
