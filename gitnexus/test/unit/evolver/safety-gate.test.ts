import { describe, expect, it } from 'vitest';
import { decidePromotion } from '../../../src/core/evolver/index.js';
import type { EvaluationReport, VariantSpec } from '../../../src/core/evolver/index.js';

const capturedAt = '2026-05-25T00:00:00.000Z';

function parameterVariant(overrides: Partial<VariantSpec> = {}): VariantSpec {
  return {
    id: 'variant-parameter-1',
    planId: 'plan-1',
    mutationType: 'parameter',
    description: 'Adjust topK',
    patch: {
      operations: [
        {
          op: 'setParameter',
          path: 'retrieval.topK',
          previousValue: 5,
          nextValue: 8,
        },
      ],
    },
    expectedGain: [
      {
        metricId: 'task_success_rate',
        expectedDelta: 0.05,
        direction: 'increase',
      },
    ],
    riskLevel: 'low',
    rollbackPlan: {
      strategy: 'restore-previous-parameters',
      operations: [
        {
          op: 'setParameter',
          path: 'retrieval.topK',
          previousValue: 8,
          nextValue: 5,
        },
      ],
    },
    provenance: [
      {
        source: 'synthetic-benchmark',
        reference: 'run-1',
        capturedAt,
      },
    ],
    ...overrides,
  };
}

function promoteReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    id: 'report-1',
    variantId: 'variant-parameter-1',
    baselineId: 'baseline-1',
    metricDeltas: [
      {
        metricId: 'task_success_rate',
        baselineValue: 0.72,
        candidateValue: 0.81,
        delta: 0.09,
        direction: 'increase',
        passed: true,
      },
    ],
    regressions: [],
    resourceCost: {
      durationMs: 120,
      computeUnits: 1,
      apiCostUsd: 0,
      storageBytes: 256,
    },
    safetyFindings: [],
    verdict: 'promote',
    ...overrides,
  };
}

describe('decidePromotion', () => {
  it('allows a low-risk parameter variant with valid evaluation, provenance, rollback, and safety checks', () => {
    const decision = decidePromotion(parameterVariant(), promoteReport());

    expect(decision).toEqual({
      id: 'gate-variant-parameter-1-report-1',
      variantId: 'variant-parameter-1',
      reportId: 'report-1',
      decision: 'allow',
      reasons: ['parameter variant passed promotion gate'],
      decidedAt: capturedAt,
    });
  });

  it('marks an algorithm variant as needs-review', () => {
    const variant = parameterVariant({
      id: 'variant-algorithm-1',
      mutationType: 'algorithm',
      riskLevel: 'medium',
      patch: {
        operations: [
          {
            op: 'selectAlgorithm',
            policyId: 'ranking-policy',
            previousAlgorithm: 'baseline-ranker',
            nextAlgorithm: 'candidate-ranker',
          },
        ],
      },
      rollbackPlan: {
        strategy: 'disable-candidate',
        operations: [
          {
            op: 'selectAlgorithm',
            policyId: 'ranking-policy',
            previousAlgorithm: 'candidate-ranker',
            nextAlgorithm: 'baseline-ranker',
          },
        ],
      },
    });

    const decision = decidePromotion(
      variant,
      promoteReport({ id: 'report-algorithm', variantId: variant.id, verdict: 'needs-review' }),
    );

    expect(decision.decision).toBe('needs-review');
    expect(decision.reasons).toEqual(['algorithm variants require review before promotion']);
  });

  it('marks a structure variant as needs-review', () => {
    const variant = parameterVariant({
      id: 'variant-structure-1',
      mutationType: 'structure',
      riskLevel: 'high',
      patch: {
        operations: [
          {
            op: 'proposeStructureChange',
            planPath: 'docs/aegis/plans/structure-change.md',
            summary: 'Split evaluator into a plugin pipeline',
          },
        ],
      },
      rollbackPlan: {
        strategy: 'manual-review-required',
        operations: [],
      },
    });

    const decision = decidePromotion(
      variant,
      promoteReport({ id: 'report-structure', variantId: variant.id, verdict: 'needs-review' }),
    );

    expect(decision.decision).toBe('needs-review');
    expect(decision.reasons).toEqual(['structure variants require review before promotion']);
  });

  it('rejects a variant without provenance', () => {
    const decision = decidePromotion(parameterVariant({ provenance: [] }), promoteReport());

    expect(decision.decision).toBe('reject');
    expect(decision.reasons).toEqual(['variant provenance is required']);
  });

  it('rejects a variant without rollback operations', () => {
    const decision = decidePromotion(
      parameterVariant({
        rollbackPlan: {
          strategy: 'restore-previous-parameters',
          operations: [],
        },
      }),
      promoteReport(),
    );

    expect(decision.decision).toBe('reject');
    expect(decision.reasons).toEqual(['rollback operations are required for automatic promotion']);
  });

  it('rejects a variant when the evaluation report contains safety findings', () => {
    const decision = decidePromotion(
      parameterVariant(),
      promoteReport({
        safetyFindings: [
          {
            id: 'safety-1',
            severity: 'high',
            message: 'unsafe action attempted',
          },
        ],
        verdict: 'reject',
      }),
    );

    expect(decision.decision).toBe('reject');
    expect(decision.reasons).toEqual(['evaluation report contains safety findings']);
  });
});
