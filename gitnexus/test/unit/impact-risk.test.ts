import { describe, expect, it } from 'vitest';
import {
  scoreImpactRisk,
  unusedAxesForImpactWalk,
  type ImpactRiskInput,
  type UnusedImpactRiskAxis,
} from 'gitnexus-shared';

const fileUnusedAxes: readonly UnusedImpactRiskAxis[] = [
  {
    axis: 'processes',
    reason: 'file-nodes-have-no-process-or-community-membership',
  },
  {
    axis: 'modules',
    reason: 'file-nodes-have-no-process-or-community-membership',
  },
];

const base: ImpactRiskInput = {
  direction: 'upstream',
  directCount: 0,
  processCount: 0,
  moduleCount: 0,
  impactedCount: 1,
};

describe('scoreImpactRisk', () => {
  it('makes the issue #3075 File and Function scales explicit', () => {
    const file = scoreImpactRisk({
      ...base,
      directCount: 13,
      impactedCount: 25,
      unusedAxes: fileUnusedAxes,
    });
    const fn = scoreImpactRisk({
      ...base,
      directCount: 2,
      processCount: 4,
      moduleCount: 2,
      impactedCount: 15,
    });

    expect(file).toEqual({
      risk: 'MEDIUM',
      riskSharedAxes: 'MEDIUM',
      riskScale: {
        comparableAcrossKinds: false,
        unusedAxes: fileUnusedAxes,
      },
    });
    expect(fn).toEqual({
      risk: 'HIGH',
      riskSharedAxes: 'LOW',
      riskScale: {
        comparableAcrossKinds: true,
        unusedAxes: [],
      },
    });
  });

  it('preserves UNKNOWN only for an empty upstream walk', () => {
    expect(scoreImpactRisk({ ...base, impactedCount: 0 }).risk).toBe('UNKNOWN');
    expect(scoreImpactRisk({ ...base, direction: 'downstream', impactedCount: 0 }).risk).toBe(
      'LOW',
    );
  });

  it('marks skipped enrichment as a non-comparable scale', () => {
    const skippedAxes: readonly UnusedImpactRiskAxis[] = [
      { axis: 'processes', reason: 'enrichment-skipped' },
      { axis: 'modules', reason: 'enrichment-skipped' },
    ];

    expect(scoreImpactRisk({ ...base, unusedAxes: skippedAxes }).riskScale).toEqual({
      comparableAcrossKinds: false,
      unusedAxes: skippedAxes,
    });
  });

  it('preserves direct and total thresholds when enrichment axes are unused', () => {
    expect(
      scoreImpactRisk({
        ...base,
        directCount: 30,
        impactedCount: 30,
        unusedAxes: fileUnusedAxes,
      }).risk,
    ).toBe('CRITICAL');
    expect(
      scoreImpactRisk({
        ...base,
        directCount: 15,
        impactedCount: 15,
        unusedAxes: fileUnusedAxes,
      }).risk,
    ).toBe('HIGH');
    expect(
      scoreImpactRisk({
        ...base,
        directCount: 2,
        processCount: 10,
        moduleCount: 10,
        unusedAxes: fileUnusedAxes,
      }).risk,
    ).toBe('LOW');
  });

  it('zeros unused process/module counts on the primary risk ladder', () => {
    const skippedAxes: readonly UnusedImpactRiskAxis[] = [
      { axis: 'processes', reason: 'enrichment-skipped' },
      { axis: 'modules', reason: 'enrichment-skipped' },
    ];
    const scored = scoreImpactRisk({
      ...base,
      directCount: 2,
      processCount: 4,
      moduleCount: 4,
      impactedCount: 15,
      unusedAxes: skippedAxes,
    });
    expect(scored.risk).toBe('LOW');
    expect(scored.riskSharedAxes).toBe('LOW');
  });

  it('preserves a warning already proved before a later enrichment failure', () => {
    const scored = scoreImpactRisk({
      ...base,
      directCount: 2,
      processCount: 5,
      impactedCount: 5,
      unusedAxes: [{ axis: 'processes', reason: 'enrichment-query-failed' }],
    });

    expect(scored.risk).toBe('CRITICAL');
    expect(scored.riskSharedAxes).toBe('LOW');
    expect(scored.riskScale.comparableAcrossKinds).toBe(false);
  });

  it('fails closed when query failure leaves only a LOW or MEDIUM observed score', () => {
    for (const directCount of [2, 6]) {
      const scored = scoreImpactRisk({
        ...base,
        direction: 'downstream',
        directCount,
        processCount: 0,
        impactedCount: directCount,
        unusedAxes: [{ axis: 'processes', reason: 'enrichment-query-failed' }],
      });
      expect(scored.risk).toBe('UNKNOWN');
    }
  });

  it('fails closed when a truncated sample leaves only a LOW or MEDIUM observed score', () => {
    const truncatedAxes: readonly UnusedImpactRiskAxis[] = [
      { axis: 'processes', reason: 'enrichment-truncated' },
      { axis: 'modules', reason: 'enrichment-truncated' },
    ];
    const scored = scoreImpactRisk({
      ...base,
      direction: 'downstream',
      directCount: 2,
      processCount: 1,
      moduleCount: 1,
      impactedCount: 8,
      unusedAxes: truncatedAxes,
    });
    expect(scored.risk).toBe('UNKNOWN');
    expect(scored.riskScale.comparableAcrossKinds).toBe(false);
  });
});

describe('unusedAxesForImpactWalk', () => {
  it('marks File, skipEnrichment, zero budget, and query failure distinctly', () => {
    expect(
      unusedAxesForImpactWalk({
        isFileTarget: true,
        skipEnrichment: false,
        maxChunks: 10,
        processQueryFailed: true,
        moduleQueryFailed: true,
        impactedCount: 1,
      }).every((a) => a.reason === 'file-nodes-have-no-process-or-community-membership'),
    ).toBe(true);
    expect(
      unusedAxesForImpactWalk({
        isFileTarget: false,
        skipEnrichment: true,
        maxChunks: 0,
        processQueryFailed: false,
        moduleQueryFailed: false,
        impactedCount: 1,
      }).map((a) => a.reason),
    ).toEqual(['enrichment-skipped', 'enrichment-skipped']);
    expect(
      unusedAxesForImpactWalk({
        isFileTarget: false,
        skipEnrichment: false,
        maxChunks: 0,
        processQueryFailed: false,
        moduleQueryFailed: false,
        impactedCount: 1,
      }).map((a) => a.reason),
    ).toEqual(['enrichment-budget-exhausted', 'enrichment-budget-exhausted']);
    expect(
      unusedAxesForImpactWalk({
        isFileTarget: false,
        skipEnrichment: false,
        maxChunks: 10,
        processQueryFailed: true,
        moduleQueryFailed: false,
        impactedCount: 1,
      }),
    ).toEqual([{ axis: 'processes', reason: 'enrichment-query-failed' }]);
    expect(
      unusedAxesForImpactWalk({
        isFileTarget: false,
        skipEnrichment: false,
        maxChunks: 0,
        processQueryFailed: false,
        moduleQueryFailed: false,
        impactedCount: 0,
      }),
    ).toEqual([]);
    expect(
      unusedAxesForImpactWalk({
        isFileTarget: false,
        skipEnrichment: false,
        maxChunks: 10,
        processQueryFailed: false,
        moduleQueryFailed: false,
        impactedCount: 501,
        enrichmentTruncated: true,
      }).map((a) => a.reason),
    ).toEqual(['enrichment-truncated', 'enrichment-truncated']);
  });
});
