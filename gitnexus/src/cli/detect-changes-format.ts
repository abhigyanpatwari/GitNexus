import { t } from './i18n/index.js';
import { formatSymbolLine } from './format-symbol.js';
import { formatPathForTerminal } from './format-path.js';

type DetectChangesSummary = {
  changed_files?: number;
  changed_count?: number;
  documentation_sections?: number;
  documentation_basis?: 'indexed_headings';
  incompatible_call_count?: number;
  affected_count?: number;
  risk_level?: string;
  message?: string;
};

type ChangedSymbol = {
  type?: string;
  name?: string;
  filePath?: string;
};

type ChangedStep = {
  symbol?: string;
};

type AffectedProcess = {
  name?: string;
  step_count?: number;
  changed_steps?: ChangedStep[];
};

type DetectChangesResult = {
  error?: unknown;
  partial?: boolean;
  truncated?: boolean;
  summary?: DetectChangesSummary;
  changed_symbols?: ChangedSymbol[];
  affected_processes?: AffectedProcess[];
  unmapped_files?: string[];
  unverified_line_files?: string[];
  incompatible_calls?: import('../core/ingestion/call-compatibility.js').BrokenKeywordCall[];
  incompatible_call_skips?: { filePath?: string; reason: string }[];
};

export function formatDetectChangesResult(result: unknown): string {
  const payload = (result ?? {}) as DetectChangesResult;
  if (payload.error) return t('common.error', { message: String(payload.error) });

  const summary = payload.summary ?? {};
  // A swallowed query failure sets `partial` and leaves the counts at zero
  // (#2283). Printing only "No changes detected." turns a degraded run into a
  // clean bill of health for the pre-commit gate, so say so either way.
  // `truncated` is its sibling flag: the backend caps the changed_symbols
  // LISTING (never the counts), so a short list is not proof of a short diff.
  // Both lead the output — a caveat printed after the summary is read too late.
  const notes: string[] = [];
  if (payload.partial)
    notes.push(
      t(
        payload.incompatible_call_skips?.length
          ? 'tool.detectChanges.partialCheck'
          : 'tool.detectChanges.partial',
      ),
    );
  if (payload.incompatible_call_skips?.length) {
    const skipped = payload.incompatible_call_skips;
    const examples = skipped
      .slice(0, 5)
      .map(({ filePath, reason }) =>
        filePath
          ? `${formatPathForTerminal(filePath)} (${formatPathForTerminal(reason)})`
          : formatPathForTerminal(reason),
      );
    if (skipped.length > examples.length) examples.push('…');
    notes.push(t('tool.detectChanges.keywordCoverage', { examples: examples.join(', ') }));
  }
  if (summary.documentation_basis === 'indexed_headings')
    notes.push(t('tool.detectChanges.indexedHeadings'));
  if (payload.unmapped_files?.length) {
    notes.push(
      t('tool.detectChanges.unmappedSource', {
        files: payload.unmapped_files.map(formatPathForTerminal).join(', '),
      }),
    );
  }
  if (payload.unverified_line_files?.length) {
    notes.push(
      t('tool.detectChanges.unverifiedLines', {
        files: payload.unverified_line_files.map(formatPathForTerminal).join(', '),
      }),
    );
  }
  // The plain truncation note reassures that the counts are whole. That is only
  // true when the run did NOT also degrade — `changed_count` sums the batches
  // that succeeded — so the two flags together get a different sentence.
  if (payload.truncated)
    notes.push(
      t(payload.partial ? 'tool.detectChanges.truncatedDegraded' : 'tool.detectChanges.truncated'),
    );

  if ((summary.changed_count ?? 0) === 0 && !payload.incompatible_calls?.length) {
    if (summary.documentation_sections)
      notes.push(t('tool.detectChanges.docSections', { count: summary.documentation_sections }));
    // Parse-fail payloads set `partial` and an honest `message` (#2915/#3131).
    // Production *clean* trees also set English `message: 'No changes detected.'`
    // — that must go through `t('tool.detectChanges.noChanges')` or zh-CN never
    // fires. Only pass the backend string through on a degraded/parse-fail run.
    if (
      payload.partial &&
      typeof summary.message === 'string' &&
      summary.message.trim().length > 0
    ) {
      return [...notes, summary.message.trim()].join('\n');
    }
    // Confirmed no-overlap: files parsed, mapping succeeded, zero symbols.
    // `queryDegraded` is `partial: true` with the same counts and no message —
    // do not call that a confirmed mapping (#3131 honesty).
    if (summary.documentation_sections) return notes.join('\n');
    if (!payload.partial && (summary.changed_files ?? 0) > 0) {
      return [
        ...notes,
        t('tool.detectChanges.noOverlappingSymbols', { files: summary.changed_files }),
      ].join('\n');
    }
    if (payload.partial) {
      return notes.join('\n');
    }
    return [...notes, t('tool.detectChanges.noChanges')].join('\n');
  }

  const lines: string[] = [];
  if (notes.length > 0) lines.push(...notes, '');
  lines.push(
    t('tool.detectChanges.changesSummary', {
      files: summary.changed_files ?? 0,
      symbols: summary.changed_count ?? 0,
    }),
  );
  if (summary.documentation_sections)
    lines.push(t('tool.detectChanges.docSections', { count: summary.documentation_sections }));
  lines.push(t('tool.detectChanges.affectedProcesses', { count: summary.affected_count ?? 0 }));
  lines.push(
    t('tool.detectChanges.riskLevel', {
      risk: summary.risk_level || t('tool.detectChanges.unknownRisk'),
    }),
  );
  lines.push('');

  if (payload.incompatible_calls?.length) {
    lines.push(t('tool.detectChanges.incompatibleCalls'));
    const shown = payload.incompatible_calls.slice(0, 15);
    for (const call of shown) {
      lines.push(
        t('tool.detectChanges.removedKeyword', {
          file: formatPathForTerminal(call.filePath),
          line: call.line,
          keyword: (call.keywords ?? [call.keyword]).join(', '),
          name: call.name,
        }),
      );
    }
    const total = summary.incompatible_call_count ?? payload.incompatible_calls.length;
    if (total > shown.length)
      lines.push(t('tool.detectChanges.overflowMore', { count: total - shown.length }));
    lines.push('');
  }

  const changed = Array.isArray(payload.changed_symbols) ? payload.changed_symbols : [];
  if (changed.length > 0) {
    lines.push(t('tool.detectChanges.changedSymbols'));
    const shown = changed.slice(0, 15);
    for (const symbol of shown) {
      lines.push(formatSymbolLine(symbol.type, symbol.name, symbol.filePath));
    }
    // Overflow is measured against the TRUE total (summary.changed_count), not
    // the array length — the array may already be `--limit`-sliced, so using its
    // length would under-report (or hide) how many symbols are not shown.
    const totalChanged = summary.changed_count ?? changed.length;
    if (totalChanged > shown.length) {
      lines.push(t('tool.detectChanges.overflowMore', { count: totalChanged - shown.length }));
    }
    lines.push('');
  }

  const affected = Array.isArray(payload.affected_processes) ? payload.affected_processes : [];
  if (affected.length > 0) {
    lines.push(t('tool.detectChanges.affectedExecutionFlows'));
    const shownAffected = affected.slice(0, 10);
    for (const processInfo of shownAffected) {
      const changedSteps = Array.isArray(processInfo.changed_steps)
        ? processInfo.changed_steps
        : [];
      const steps = changedSteps.map((step) => step.symbol ?? '?').join(', ');
      lines.push(
        `  • ${processInfo.name ?? '?'} (${t('tool.detectChanges.steps', {
          count: processInfo.step_count ?? 0,
        })}) — ${t('tool.detectChanges.changedSteps', { steps })}`,
      );
    }
    const totalAffected = summary.affected_count ?? affected.length;
    if (totalAffected > shownAffected.length) {
      lines.push(
        t('tool.detectChanges.overflowMore', { count: totalAffected - shownAffected.length }),
      );
    }
  }

  return lines.join('\n').trim();
}
