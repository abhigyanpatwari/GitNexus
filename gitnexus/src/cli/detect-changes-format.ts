import { t } from './i18n/index.js';

type DetectChangesSummary = {
  changed_files?: number;
  changed_count?: number;
  affected_count?: number;
  risk_level?: string;
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
  summary?: DetectChangesSummary;
  changed_symbols?: ChangedSymbol[];
  affected_processes?: AffectedProcess[];
};

export function formatDetectChangesResult(result: unknown): string {
  const payload = (result ?? {}) as DetectChangesResult;
  if (payload.error) return t('common.error', { message: String(payload.error) });

  const summary = payload.summary ?? {};
  if ((summary.changed_count ?? 0) === 0) {
    return t('tool.detectChanges.noChanges');
  }

  const lines: string[] = [];
  lines.push(
    t('tool.detectChanges.changesSummary', {
      files: summary.changed_files ?? 0,
      symbols: summary.changed_count ?? 0,
    }),
  );
  lines.push(t('tool.detectChanges.affectedProcesses', { count: summary.affected_count ?? 0 }));
  lines.push(
    t('tool.detectChanges.riskLevel', {
      risk: summary.risk_level || t('tool.detectChanges.unknownRisk'),
    }),
  );
  lines.push('');

  const changed = Array.isArray(payload.changed_symbols) ? payload.changed_symbols : [];
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
