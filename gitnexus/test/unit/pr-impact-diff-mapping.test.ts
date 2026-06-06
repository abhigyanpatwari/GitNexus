import { describe, expect, it } from 'vitest';
import {
  classifyPrImpactRanges,
  type PrImpactChangedRange,
  type PrImpactIndexedSymbol,
} from '../../src/core/pr-impact/diff-mapping.js';

const symbols: PrImpactIndexedSymbol[] = [
  {
    id: 'Function:src/auth.ts:validateUser',
    name: 'validateUser',
    kind: 'Function',
    filePath: 'src/auth.ts',
    startLine: 10,
    endLine: 20,
  },
  {
    id: 'Function:src/auth.ts:formatLogin',
    name: 'formatLogin',
    kind: 'Function',
    filePath: 'src/auth.ts',
    startLine: 30,
    endLine: 38,
  },
];

describe('PR Impact diff mapping', () => {
  it('maps overlapping changed ranges to indexed symbols and keeps unmatched ranges', () => {
    const ranges: PrImpactChangedRange[] = [
      { filePath: 'src/auth.ts', startLine: 12, endLine: 14, changeType: 'modified' },
      { filePath: 'src/auth.ts', startLine: 24, endLine: 26, changeType: 'modified' },
    ];

    const result = classifyPrImpactRanges({ ranges, symbols });

    expect(result.mappedSymbols).toHaveLength(1);
    expect(result.mappedSymbols[0]).toMatchObject({
      id: 'Function:src/auth.ts:validateUser',
      changeType: 'modified',
    });
    expect(result.unmatchedRanges).toEqual([
      {
        filePath: 'src/auth.ts',
        startLine: 24,
        endLine: 26,
        reason: 'No indexed symbol overlapped this changed range',
      },
    ]);
  });

  it('classifies old-side deletion ranges separately so callers can resolve base-graph impact', () => {
    const result = classifyPrImpactRanges({
      ranges: [
        {
          filePath: 'src/auth.ts',
          startLine: 30,
          endLine: 38,
          changeType: 'deleted',
          side: 'old',
        },
      ],
      symbols,
    });

    expect(result.deletedSymbols).toEqual([
      {
        id: 'Function:src/auth.ts:formatLogin',
        name: 'formatLogin',
        kind: 'Function',
        filePath: 'src/auth.ts',
        inboundCallers: 0,
      },
    ]);
    expect(result.mappedSymbols).toEqual([]);
  });

  it('classifies added ranges without a graph match as new or unmapped symbols', () => {
    const result = classifyPrImpactRanges({
      ranges: [
        {
          filePath: 'src/new-helper.ts',
          startLine: 1,
          endLine: 8,
          changeType: 'added',
          symbolName: 'newHelper',
          symbolKind: 'Function',
        },
      ],
      symbols,
    });

    expect(result.newSymbols).toEqual([
      {
        name: 'newHelper',
        kind: 'Function',
        filePath: 'src/new-helper.ts',
        reason: 'New symbol is not present in the base graph',
      },
    ]);
    expect(result.unmatchedRanges).toEqual([]);
  });
});
