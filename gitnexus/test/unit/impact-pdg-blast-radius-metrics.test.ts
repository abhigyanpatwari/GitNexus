import { describe, expect, it } from 'vitest';

import {
  median,
  parseMarkdownRows,
  summarizeBlastRadius,
  symbolSetFromByDepth,
} from '../../bench/impact-pdg/blast-radius.mjs';

describe('impact-pdg blast-radius metric helpers', () => {
  it('parses a cypher markdown table into row objects', () => {
    const md = [
      '| id | startLine |',
      '| --- | --- |',
      '| BasicBlock:a.ts:5:2:0 | 6 |',
      '| BasicBlock:a.ts:5:2:1 | 9 |',
    ].join('\n');

    expect(parseMarkdownRows(md)).toEqual([
      { id: 'BasicBlock:a.ts:5:2:0', startLine: '6' },
      { id: 'BasicBlock:a.ts:5:2:1', startLine: '9' },
    ]);
    expect(parseMarkdownRows('')).toEqual([]);
    expect(parseMarkdownRows('| n |\n| --- |')).toEqual([]);
  });

  it('builds a stable symbol-id set from a byDepth record', () => {
    const set = symbolSetFromByDepth({
      1: [
        { id: 'Function:src/a.ts:a', name: 'a', filePath: 'src/a.ts' },
        { id: '', name: 'dynamic', filePath: 'src/b.ts' },
      ],
      2: [{ id: 'Method:src/c.ts:C.m', name: 'm', filePath: 'src/c.ts' }],
    });

    expect([...set].sort()).toEqual([
      'Function:src/a.ts:a',
      'Method:src/c.ts:C.m',
      'dynamic@src/b.ts',
    ]);
  });

  it('summarizes localization, inter-symbol agreement, and latency', () => {
    const summary = summarizeBlastRadius([
      {
        bodyBlocks: 20,
        sliceBlocks: 4,
        ratio: 0.2,
        pdgOnly: 0,
        cgOnly: 0,
        callgraphMs: 100,
        pdgMs: 150,
      },
      {
        bodyBlocks: 16,
        sliceBlocks: 8,
        ratio: 0.5,
        pdgOnly: 0,
        cgOnly: 0,
        callgraphMs: 80,
        pdgMs: 120,
      },
      {
        bodyBlocks: 10,
        sliceBlocks: 10,
        ratio: 1,
        pdgOnly: 2,
        cgOnly: 1,
        callgraphMs: 60,
        pdgMs: 90,
      },
    ]);

    expect(summary.n).toBe(3);
    expect(summary.localization).toMatchObject({
      medianSliceOverBody: 0.5,
      meanSliceOverBody: 0.567,
      medianBodyBlocks: 16,
      medianSliceBlocks: 8,
      casesSliceSmallerThanBody: 2,
    });
    expect(summary.interSymbol).toMatchObject({
      casesPdgFindsMore: 1,
      casesPdgFindsFewer: 1,
      casesIdentical: 2,
      totalPdgOnlySymbols: 2,
      totalCgOnlySymbols: 1,
    });
    expect(summary.latency).toMatchObject({
      medianCallgraphMs: 80,
      medianPdgMs: 120,
      medianPdgOverCallgraph: 1.5,
    });
  });

  it('computes median deterministically (odd and even lengths)', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(null);
  });
});
