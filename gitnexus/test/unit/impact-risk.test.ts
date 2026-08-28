import { describe, expect, it } from 'vitest';
import { scoreImpactRisk, type ImpactRiskInput, type UnusedImpactRiskAxis } from 'gitnexus-shared';

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
  });
});
