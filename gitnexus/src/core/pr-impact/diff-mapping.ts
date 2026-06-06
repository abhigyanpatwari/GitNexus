export type PrImpactChangeType = 'added' | 'modified' | 'deleted';
export type PrImpactRangeSide = 'new' | 'old';

export interface PrImpactChangedRange {
  filePath: string;
  startLine: number;
  endLine: number;
  changeType: PrImpactChangeType;
  side?: PrImpactRangeSide;
  symbolName?: string;
  symbolKind?: string;
  riskHint?: 'low' | 'medium' | 'high';
}

export interface PrImpactIndexedSymbol {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  inboundCallers?: number;
}

export interface PrImpactMappedSymbol {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  changeType: PrImpactChangeType;
}

export interface PrImpactUnmatchedRange {
  filePath: string;
  startLine: number;
  endLine: number;
  reason: string;
  riskHint?: 'low' | 'medium' | 'high';
}

export interface PrImpactNewSymbol {
  name: string;
  kind: string;
  filePath: string;
  reason: string;
}

export interface PrImpactDeletedSymbol {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  inboundCallers: number;
}

export interface PrImpactRangeClassification {
  mappedSymbols: PrImpactMappedSymbol[];
  unmatchedRanges: PrImpactUnmatchedRange[];
  newSymbols: PrImpactNewSymbol[];
  deletedSymbols: PrImpactDeletedSymbol[];
}

export interface PrImpactRangeClassificationInput {
  ranges: PrImpactChangedRange[];
  symbols: PrImpactIndexedSymbol[];
}

const overlaps = (range: PrImpactChangedRange, symbol: PrImpactIndexedSymbol): boolean =>
  range.filePath === symbol.filePath &&
  symbol.startLine <= range.endLine &&
  symbol.endLine >= range.startLine;

export const classifyPrImpactRanges = (
  input: PrImpactRangeClassificationInput,
): PrImpactRangeClassification => {
  const mappedSymbols = new Map<string, PrImpactMappedSymbol>();
  const deletedSymbols = new Map<string, PrImpactDeletedSymbol>();
  const unmatchedRanges: PrImpactUnmatchedRange[] = [];
  const newSymbols: PrImpactNewSymbol[] = [];

  for (const range of input.ranges) {
    const matches = input.symbols.filter((symbol) => overlaps(range, symbol));

    if (range.changeType === 'deleted') {
      for (const symbol of matches) {
        deletedSymbols.set(symbol.id, {
          id: symbol.id,
          name: symbol.name,
          kind: symbol.kind,
          filePath: symbol.filePath,
          inboundCallers: symbol.inboundCallers ?? 0,
        });
      }
      if (matches.length === 0) {
        unmatchedRanges.push({
          filePath: range.filePath,
          startLine: range.startLine,
          endLine: range.endLine,
          reason: 'Deleted range did not resolve to a base-graph symbol',
          ...(range.riskHint ? { riskHint: range.riskHint } : {}),
        });
      }
      continue;
    }

    if (matches.length > 0) {
      for (const symbol of matches) {
        mappedSymbols.set(symbol.id, {
          id: symbol.id,
          name: symbol.name,
          kind: symbol.kind,
          filePath: symbol.filePath,
          changeType: range.changeType,
        });
      }
      continue;
    }

    if (range.changeType === 'added' && range.symbolName) {
      newSymbols.push({
        name: range.symbolName,
        kind: range.symbolKind ?? 'Symbol',
        filePath: range.filePath,
        reason: 'New symbol is not present in the base graph',
      });
      continue;
    }

    unmatchedRanges.push({
      filePath: range.filePath,
      startLine: range.startLine,
      endLine: range.endLine,
      reason: 'No indexed symbol overlapped this changed range',
      ...(range.riskHint ? { riskHint: range.riskHint } : {}),
    });
  }

  return {
    mappedSymbols: Array.from(mappedSymbols.values()),
    unmatchedRanges,
    newSymbols,
    deletedSymbols: Array.from(deletedSymbols.values()),
  };
};
