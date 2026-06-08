import {
  buildPrImpactReport,
  type PrImpactApiImpactInput,
  type PrImpactReport,
  type PrImpactReportInput,
  type PrImpactRisk,
  type PrImpactSymbolImpactInput,
} from './report.js';
import type { PrImpactMappedSymbol, PrImpactUnmatchedRange } from './diff-mapping.js';

export interface PrImpactPipelineBackend {
  callTool(method: 'detect_changes' | 'impact' | 'api_impact', params: Record<string, unknown>): Promise<any>;
}

export interface PrImpactPipelineOptions {
  scope?: string;
  baseRef?: string;
  repo?: string;
}

type DetectChangedSymbol = {
  id?: string;
  name?: string;
  type?: string;
  filePath?: string;
  change_type?: string;
};

type DetectUnmatchedRange = {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  reason?: string;
  riskHint?: unknown;
};

type DetectDeletedSymbol = {
  id?: string;
  name?: string;
  type?: string;
  kind?: string;
  filePath?: string;
  inboundCallers?: number;
  inbound_callers?: number;
};

const normalizeRisk = (risk: unknown): PrImpactRisk => {
  const upper = String(risk ?? 'UNKNOWN').toUpperCase();
  if (upper === 'LOW' || upper === 'MEDIUM' || upper === 'HIGH' || upper === 'CRITICAL') {
    return upper;
  }
  return 'UNKNOWN';
};

const normalizeChangeType = (changeType: unknown): PrImpactMappedSymbol['changeType'] => {
  if (changeType === 'added' || changeType === 'deleted' || changeType === 'modified') {
    return changeType;
  }
  return 'modified';
};

const isTestFilePath = (filePath: string): boolean =>
  /(^|[\\/])(__tests__|test|tests)([\\/]|$)/i.test(filePath) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/i.test(filePath);

const flattenByDepth = (byDepth: unknown): Array<{ filePath?: string }> => {
  if (!byDepth || typeof byDepth !== 'object') return [];
  return Object.values(byDepth as Record<string, unknown>).flatMap((value) =>
    Array.isArray(value) ? (value as Array<{ filePath?: string }>) : [],
  );
};

const toMappedSymbol = (symbol: DetectChangedSymbol): PrImpactMappedSymbol => ({
  id: symbol.id ?? `${symbol.type ?? 'Symbol'}:${symbol.filePath ?? 'unknown'}:${symbol.name ?? 'unknown'}`,
  name: symbol.name ?? 'unknown',
  kind: symbol.type ?? 'Symbol',
  filePath: symbol.filePath ?? 'unknown',
  changeType: normalizeChangeType(symbol.change_type),
});

const normalizeLine = (line: unknown): number | undefined => {
  const value = Number(line);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

const normalizeRiskHint = (riskHint: unknown): PrImpactUnmatchedRange['riskHint'] | undefined => {
  if (riskHint === 'low' || riskHint === 'medium' || riskHint === 'high') return riskHint;
  return undefined;
};

const toUnmatchedRange = (
  range: DetectUnmatchedRange,
): PrImpactUnmatchedRange | undefined => {
  const startLine = normalizeLine(range.startLine);
  const endLine = normalizeLine(range.endLine);
  if (!range.filePath || startLine === undefined || endLine === undefined) return undefined;
  const riskHint = normalizeRiskHint(range.riskHint);
  return {
    filePath: range.filePath,
    startLine,
    endLine,
    reason: range.reason ?? 'No indexed symbol overlapped this changed range',
    ...(riskHint ? { riskHint } : {}),
  };
};

const toDeletedSymbol = (symbol: DetectDeletedSymbol) => ({
  id: symbol.id ?? `${symbol.type ?? symbol.kind ?? 'Symbol'}:${symbol.filePath ?? 'unknown'}:${symbol.name ?? 'unknown'}`,
  name: symbol.name ?? 'unknown',
  kind: symbol.kind ?? symbol.type ?? 'Symbol',
  filePath: symbol.filePath ?? 'unknown',
  inboundCallers: Number(symbol.inboundCallers ?? symbol.inbound_callers ?? 0),
});

const buildImpactInput = async (
  backend: PrImpactPipelineBackend,
  symbol: PrImpactMappedSymbol,
  repo?: string,
): Promise<PrImpactSymbolImpactInput> => {
  const result = await backend.callTool('impact', {
    target: symbol.name,
    target_uid: symbol.id,
    direction: 'upstream',
    maxDepth: 5,
    includeTests: true,
    repo,
    limit: 50,
  });

  const byDepthItems = flattenByDepth(result?.byDepth);
  const hasTestReference = byDepthItems.some((item) => isTestFilePath(item.filePath ?? ''));

  return {
    symbolId: symbol.id,
    symbolName: symbol.name,
    risk: normalizeRisk(result?.risk),
    direct: Number(result?.summary?.direct ?? 0),
    processesAffected: Number(result?.summary?.processes_affected ?? 0),
    testReference: hasTestReference ? 'has_test_reference' : 'unknown_or_unreferenced',
  };
};

const isApiCandidate = (filePath: string): boolean =>
  /(^|[\\/])api([\\/]|$)/i.test(filePath) || /route\.[cm]?[jt]sx?$/i.test(filePath);

const toApiImpactInput = (result: any): PrImpactApiImpactInput | undefined => {
  if (!result || result.error || !result.route) return undefined;
  return {
    route: result.route,
    risk: normalizeRisk(result.impactSummary?.riskLevel) as Exclude<PrImpactRisk, 'UNKNOWN'>,
    consumers: Number(result.impactSummary?.directConsumers ?? result.consumers?.length ?? 0),
    mismatches: Array.isArray(result.mismatches) ? result.mismatches.length : 0,
  };
};

export const buildPrImpactPipelineReport = async (
  backend: PrImpactPipelineBackend,
  options?: PrImpactPipelineOptions,
): Promise<PrImpactReport> => {
  const scope = options?.scope || (options?.baseRef ? 'compare' : 'unstaged');
  const detectResult = await backend.callTool('detect_changes', {
    scope,
    base_ref: options?.baseRef,
    repo: options?.repo,
  });

  const changedSymbols = Array.isArray(detectResult?.changed_symbols)
    ? (detectResult.changed_symbols as DetectChangedSymbol[])
    : [];
  const mappedSymbols = changedSymbols.map(toMappedSymbol);
  const unmatchedRanges = Array.isArray(detectResult?.unmatched_ranges)
    ? (detectResult.unmatched_ranges as DetectUnmatchedRange[])
        .map(toUnmatchedRange)
        .filter((range): range is PrImpactUnmatchedRange => Boolean(range))
    : [];
  const deletedSymbols = Array.isArray(detectResult?.deleted_symbols)
    ? (detectResult.deleted_symbols as DetectDeletedSymbol[]).map(toDeletedSymbol)
    : [];

  const impacts: PrImpactSymbolImpactInput[] = [];
  for (const symbol of mappedSymbols) {
    impacts.push(await buildImpactInput(backend, symbol, options?.repo));
  }

  const apiImpacts: PrImpactApiImpactInput[] = [];
  const apiCandidateFiles = Array.from(
    new Set(mappedSymbols.map((symbol) => symbol.filePath).filter(isApiCandidate)),
  );
  for (const file of apiCandidateFiles) {
    const apiImpact = toApiImpactInput(
      await backend.callTool('api_impact', {
        file,
        repo: options?.repo,
      }),
    );
    if (apiImpact) apiImpacts.push(apiImpact);
  }

  const reportInput: PrImpactReportInput = {
    diff: {
      scope: scope as PrImpactReportInput['diff']['scope'],
      baseRef: options?.baseRef,
      headRef: scope === 'compare' ? 'HEAD' : undefined,
      filesChanged: Number(detectResult?.summary?.changed_files ?? 0),
    },
    graph: { freshness: detectResult?.error ? 'ambiguous' : 'fresh', reason: detectResult?.error },
    mappedSymbols,
    unmatchedRanges,
    newSymbols: [],
    deletedSymbols,
    impacts,
    apiImpacts,
  };

  return buildPrImpactReport(reportInput);
};
