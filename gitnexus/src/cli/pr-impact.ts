import { writeSync } from 'node:fs';
import { LocalBackend } from '../mcp/local/local-backend.js';
import {
  buildPrImpactReport,
  renderPrImpactMarkdown,
  type PrImpactApiImpactInput,
  type PrImpactReportInput,
  type PrImpactRisk,
  type PrImpactSymbolImpactInput,
} from '../core/pr-impact/report.js';
import type { PrImpactMappedSymbol } from '../core/pr-impact/diff-mapping.js';
import { cliErrorKey } from './cli-message.js';

let _backend: LocalBackend | null = null;

async function getBackend(): Promise<LocalBackend> {
  if (_backend) return _backend;
  _backend = new LocalBackend();
  const ok = await _backend.init();
  if (!ok) {
    cliErrorKey('tool.noIndexed');
    process.exit(1);
  }
  return _backend;
}

function output(data: string): void {
  try {
    writeSync(1, data + '\n');
  } catch (err: any) {
    if (err?.code === 'EPIPE') process.exit(0);
    process.stderr.write(data + '\n');
  }
}

export interface PrImpactCommandOptions {
  scope?: string;
  baseRef?: string;
  repo?: string;
  format?: string;
}

type DetectChangedSymbol = {
  id?: string;
  name?: string;
  type?: string;
  filePath?: string;
  change_type?: string;
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

const buildImpactInput = async (
  backend: LocalBackend,
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

export async function prImpactCommand(options?: PrImpactCommandOptions): Promise<void> {
  const backend = await getBackend();
  const scope = options?.scope || (options?.baseRef ? 'compare' : 'unstaged');
  const format = (options?.format || 'markdown').toLowerCase();

  const detectResult = await backend.callTool('detect_changes', {
    scope,
    base_ref: options?.baseRef,
    repo: options?.repo,
  });

  const changedSymbols = Array.isArray(detectResult?.changed_symbols)
    ? (detectResult.changed_symbols as DetectChangedSymbol[])
    : [];
  const mappedSymbols = changedSymbols.map(toMappedSymbol);

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
    unmatchedRanges: [],
    newSymbols: [],
    deletedSymbols: [],
    impacts,
    apiImpacts,
  };

  const report = buildPrImpactReport(reportInput);
  if (format === 'json') {
    output(JSON.stringify(report, null, 2));
    return;
  }
  output(renderPrImpactMarkdown(report));
}
