export interface ImpactForRangesMatchedRange {
  filePath: string;
  startLine: number;
  endLine: number;
  side?: 'new' | 'old';
  change_type?: 'added' | 'modified' | 'deleted';
}

export interface ImpactForRangesProcessEntry {
  id: string;
  name: string;
  process_type: string;
  step_index?: number;
  step_count?: number;
}

export interface ImpactForRangesSymbol {
  id: string;
  name: string;
  type: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  change_types: string[];
  matched_ranges: ImpactForRangesMatchedRange[];
  processes?: ImpactForRangesProcessEntry[];
  reason?: string;
}

export interface ImpactForRangesReport {
  schema_version: 'impact-for-ranges.v1alpha1';
  repo: {
    name: string;
    indexed_commit?: string;
  };
  summary: {
    input_ranges: number;
    matched_symbols: number;
    unmatched_ranges: number;
    deleted_symbols: number;
    symbols_with_processes: number;
    unmapped_symbols: number;
    unknown_symbols: number;
    affected_processes: number;
  };
  symbols: ImpactForRangesSymbol[];
  unmapped_symbols: ImpactForRangesSymbol[];
  unknown_symbols: Array<ImpactForRangesSymbol & { reason: string }>;
  unmatched_ranges: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    reason: string;
  }>;
  affected_processes: Array<{
    id: string;
    name: string;
    process_type: string;
    step_count?: number;
    matched_symbols: number;
  }>;
  caveats: string[];
}

const pushTable = (lines: string[], headers: string[], rows: string[][]): void => {
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${row.join(' | ')} |`);
  }
};

const summarizeRanges = (ranges: ImpactForRangesMatchedRange[]): string =>
  ranges
    .map((range) => {
      const change = range.change_type ?? 'unknown';
      const side = range.side ? ` ${range.side}` : '';
      return `\`${range.filePath}:${range.startLine}-${range.endLine}\` (${change}${side})`;
    })
    .join(', ');

const summarizeProcesses = (processes: ImpactForRangesProcessEntry[] = []): string =>
  processes
    .map((process) => {
      if (process.step_index !== undefined && process.step_count !== undefined) {
        return `${process.name} (${process.step_index}/${process.step_count})`;
      }
      return process.name;
    })
    .join(', ');

export const renderImpactForRangesMarkdown = (report: ImpactForRangesReport): string => {
  const lines: string[] = [
    '# GitNexus Impact For Ranges',
    '',
    `Schema: ${report.schema_version}`,
    '',
    '## Summary',
    '',
    `- Repo: ${report.repo.name}`,
    `- Indexed commit: ${report.repo.indexed_commit ?? 'unknown'}`,
    `- Input ranges: ${report.summary.input_ranges}`,
    `- Matched symbols: ${report.summary.matched_symbols}`,
    `- Symbols with direct processes: ${report.summary.symbols_with_processes}`,
    `- Unmapped symbols: ${report.summary.unmapped_symbols}`,
    `- Unknown symbols: ${report.summary.unknown_symbols}`,
    `- Unmatched ranges: ${report.summary.unmatched_ranges}`,
    `- Deleted symbols: ${report.summary.deleted_symbols}`,
    `- Affected processes: ${report.summary.affected_processes}`,
  ];

  if (report.affected_processes.length > 0) {
    lines.push('', '## Affected Processes', '');
    pushTable(
      lines,
      ['Process', 'Type', 'Matched Symbols', 'Steps'],
      report.affected_processes.map((process) => [
        `\`${process.name}\``,
        process.process_type,
        String(process.matched_symbols),
        process.step_count !== undefined ? String(process.step_count) : '-',
      ]),
    );
  }

  if (report.symbols.length > 0) {
    lines.push('', '## Symbols With Direct Process Evidence', '');
    pushTable(
      lines,
      ['Symbol', 'Kind', 'Change Types', 'Matched Ranges', 'Processes'],
      report.symbols.map((symbol) => [
        `\`${symbol.name}\``,
        symbol.type,
        symbol.change_types.join(', ') || 'modified',
        summarizeRanges(symbol.matched_ranges),
        summarizeProcesses(symbol.processes),
      ]),
    );
  }

  if (report.unmapped_symbols.length > 0) {
    lines.push('', '## Symbols Without Direct Process Evidence', '');
    pushTable(
      lines,
      ['Symbol', 'Kind', 'Change Types', 'Matched Ranges', 'Reason'],
      report.unmapped_symbols.map((symbol) => [
        `\`${symbol.name}\``,
        symbol.type,
        symbol.change_types.join(', ') || 'modified',
        summarizeRanges(symbol.matched_ranges),
        symbol.reason ?? 'No direct process membership found for this symbol',
      ]),
    );
  }

  if (report.unknown_symbols.length > 0) {
    lines.push('', '## Unknown Symbols', '');
    pushTable(
      lines,
      ['Symbol', 'Kind', 'Matched Ranges', 'Reason'],
      report.unknown_symbols.map((symbol) => [
        `\`${symbol.name ?? symbol.id}\``,
        symbol.type ?? 'Symbol',
        summarizeRanges(symbol.matched_ranges),
        symbol.reason,
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

  if (report.caveats.length > 0) {
    lines.push('', '## Caveats', '');
    for (const caveat of report.caveats) {
      lines.push(`- ${caveat}`);
    }
  }

  return lines.join('\n').trim();
};
