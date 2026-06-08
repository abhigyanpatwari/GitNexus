import { t } from './i18n/index.js';

type DetectChangesSummary = {
  changed_files?: number;
  changed_count?: number;
  evidence_count?: number;
  affected_count?: number;
  risk_level?: string;
};

type ChangedSymbol = {
  type?: string;
  name?: string;
  filePath?: string;
};

type DeletedSymbol = ChangedSymbol & {
  inboundCallers?: number;
};

type UnmatchedRange = {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  reason?: string;
};

type ChangedRange = Omit<UnmatchedRange, 'reason'> & {
  change_type?: string;
  side?: string;
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
  summary?: DetectChangesSummary;
  changed_ranges?: ChangedRange[];
  unmatched_ranges?: UnmatchedRange[];
  deleted_symbols?: DeletedSymbol[];
  changed_symbols?: ChangedSymbol[];
  affected_processes?: AffectedProcess[];
};

export function formatDetectChangesResult(result: unknown): string {
  const payload = (result ?? {}) as DetectChangesResult;
  if (payload.error) return t('common.error', { message: String(payload.error) });

  const summary = payload.summary ?? {};
  const changed = Array.isArray(payload.changed_symbols) ? payload.changed_symbols : [];
  const changedRanges = Array.isArray(payload.changed_ranges) ? payload.changed_ranges : [];
  const unmatched = Array.isArray(payload.unmatched_ranges) ? payload.unmatched_ranges : [];
  const deleted = Array.isArray(payload.deleted_symbols) ? payload.deleted_symbols : [];
  const evidenceCount =
    summary.evidence_count ?? changedRanges.length + unmatched.length + deleted.length + changed.length;
  const hasChangeEvidence =
    (summary.changed_count ?? 0) > 0 ||
    evidenceCount > 0 ||
    changed.length > 0 ||
    changedRanges.length > 0 ||
    unmatched.length > 0 ||
    deleted.length > 0;

  if (!hasChangeEvidence) {
    return t('tool.detectChanges.noChanges');
  }

  const lines: string[] = [];
  lines.push(
    t('tool.detectChanges.changesSummary', {
      files: summary.changed_files ?? 0,
      symbols: summary.changed_count ?? 0,
    }),
  );
  lines.push(t('tool.detectChanges.evidenceSummary', { count: evidenceCount }));
  lines.push(t('tool.detectChanges.affectedProcesses', { count: summary.affected_count ?? 0 }));
  lines.push(
    t('tool.detectChanges.riskLevel', {
      risk: summary.risk_level || t('tool.detectChanges.unknownRisk'),
    }),
  );
  lines.push('');

  if (changed.length > 0) {
    lines.push(t('tool.detectChanges.changedSymbols'));
    for (const symbol of changed.slice(0, 15)) {
      lines.push(`  ${symbol.type ?? 'Symbol'} ${symbol.name ?? '?'} → ${symbol.filePath ?? '?'}`);
    }
    if (changed.length > 15) {
      lines.push(t('tool.detectChanges.overflowMore', { count: changed.length - 15 }));
    }
    lines.push('');
  }

  if (deleted.length > 0) {
    lines.push(t('tool.detectChanges.deletedSymbols'));
    for (const symbol of deleted.slice(0, 15)) {
      lines.push(
        `  ${symbol.type ?? 'Symbol'} ${symbol.name ?? '?'} → ${symbol.filePath ?? '?'} (inbound callers: ${symbol.inboundCallers ?? 0})`,
      );
    }
    if (deleted.length > 15) {
      lines.push(t('tool.detectChanges.overflowMore', { count: deleted.length - 15 }));
    }
    lines.push('');
  }

  if (unmatched.length > 0) {
    lines.push(t('tool.detectChanges.unmatchedRanges'));
    for (const range of unmatched.slice(0, 15)) {
      lines.push(
        `  ${range.filePath ?? '?'}:${range.startLine ?? '?'}-${range.endLine ?? '?'} — ${range.reason ?? '?'}`,
      );
    }
    if (unmatched.length > 15) {
      lines.push(t('tool.detectChanges.overflowMore', { count: unmatched.length - 15 }));
    }
    lines.push('');
  }

  const affected = Array.isArray(payload.affected_processes) ? payload.affected_processes : [];
  if (affected.length > 0) {
    lines.push(t('tool.detectChanges.affectedExecutionFlows'));
    for (const processInfo of affected.slice(0, 10)) {
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
  }

  return lines.join('\n').trim();
}
