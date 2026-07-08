import { describe, expect, it } from 'vitest';

import {
  compareSymbolSets,
  evaluateCheckGates,
  median,
  percentile,
  summarizeCases,
  symbolKeysFromByDepth,
} from '../../bench/impact-pdg/real-code.mjs';

describe('impact-pdg real-code metric helpers', () => {
  it('extracts stable symbol keys from byDepth records', () => {
    const keys = symbolKeysFromByDepth({
      1: [
        { id: 'Function:src/a.ts:a', name: 'a', filePath: 'src/a.ts' },
        { id: null, name: 'dynamicTarget', filePath: 'src/b.ts' },
      ],
    });

    expect([...keys].sort()).toEqual(['Function:src/a.ts:a', 'dynamicTarget@src/b.ts']);
  });

  it('compares candidate symbol reach against a reference set', () => {
    const comparison = compareSymbolSets(new Set(['A', 'B']), new Set(['A', 'C']));

    expect(comparison).toMatchObject({
      referenceSize: 2,
      candidateSize: 2,
      overlapSize: 1,
      recallVsReference: 0.5,
      precisionVsReference: 0.5,
      jaccard: 1 / 3,
      referenceOnly: ['B'],
      candidateOnly: ['C'],
    });
  });

  it('summarizes latency and quality proxy metrics across cases', () => {
    const summary = summarizeCases([
      {
        latencyMs: {
          callgraph: { median: 10 },
          pdg: { median: 25, p95: 30 },
          pdgOverCallgraphMedian: 2.5,
        },
        callgraph: { error: null, partial: false },
        pdg: {
          error: null,
          pdgLayer: 'ready',
          partial: false,
          epistemic: 'pdg-intra-procedural',
          evidenceCounts: { 'callgraph-bridge': 2 },
        },
        symbolAgreement: {
          recallVsReference: 1,
          precisionVsReference: 1,
        },
      },
      {
        latencyMs: {
          callgraph: { median: 20 },
          pdg: { median: 40, p95: 45 },
          pdgOverCallgraphMedian: 2,
        },
        callgraph: { error: null, partial: false },
        pdg: {
          error: null,
          pdgLayer: 'ready',
          partial: true,
          epistemic: 'pdg-intra-procedural',
          evidenceCounts: { 'unproven-bridge': 1 },
        },
        symbolAgreement: {
          recallVsReference: 0.5,
          precisionVsReference: 1,
        },
      },
    ] as any);

    expect(summary.performance).toMatchObject({
      callgraphMedianMs: 15,
      pdgMedianMs: 32.5,
      pdgP95Ms: 45,
      pdgOverCallgraphMedian: 2.25,
    });
    expect(summary.qualityProxy).toMatchObject({
      comparableCases: 2,
      meanSymbolRecallVsCallgraph: 0.75,
      minSymbolRecallVsCallgraph: 0.5,
      meanSymbolPrecisionVsCallgraph: 1,
      degradedCaseCount: 0,
      errorCaseCount: 0,
      partialCaseCount: 1,
      evidenceCounts: { 'callgraph-bridge': 2, 'unproven-bridge': 1 },
      unprovenBridgeRatio: 0.333,
    });
  });

  it('reports explicit check failures for degraded quality and slow PDG medians', () => {
    const failures = evaluateCheckGates(
      {
        cases: [{}],
        summary: {
          performance: { pdgMedianMs: 600 },
          qualityProxy: {
            errorCaseCount: 1,
            degradedCaseCount: 1,
            minSymbolRecallVsCallgraph: 0.5,
          },
        },
      } as any,
      {
        GN_REAL_CODE_PDG_MIN_SYMBOL_RECALL: '0.9',
        GN_REAL_CODE_PDG_MAX_MEDIAN_MS: '500',
      } as any,
    );

    expect(failures).toEqual([
      '1 case(s) returned errors',
      '1 case(s) reported a degraded PDG layer',
      'min PDG symbol recall vs callgraph 0.5 < 0.9',
      'PDG median latency 600ms > 500ms',
    ]);
  });

  it('computes median and percentile deterministically', () => {
    expect(median([9, 1, 3])).toBe(3);
    expect(median([9, 1, 3, 5])).toBe(4);
    expect(percentile([10, 30, 20], 95)).toBe(30);
  });
});
