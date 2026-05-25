import { describe, expect, it } from 'vitest';
import { applyPromotion, rollbackPromotion } from '../../../src/core/evolver/index.js';
import type { GateDecision, VariantSpec } from '../../../src/core/evolver/index.js';

const capturedAt = '2026-05-25T00:00:00.000Z';

function parameterVariant(): VariantSpec {
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
  };
}

function allowDecision(): GateDecision {
  return {
    id: 'gate-variant-parameter-1-report-1',
    variantId: 'variant-parameter-1',
    reportId: 'report-1',
    decision: 'allow',
    reasons: ['parameter variant passed promotion gate'],
    decidedAt: capturedAt,
  };
}

function needsReviewDecision(): GateDecision {
  return {
    id: 'gate-variant-algorithm-1-report-2',
    variantId: 'variant-algorithm-1',
    reportId: 'report-2',
    decision: 'needs-review',
    reasons: ['algorithm variants require review before promotion'],
    decidedAt: capturedAt,
  };
}

function rejectDecision(): GateDecision {
  return {
    id: 'gate-variant-parameter-1-report-3',
    variantId: 'variant-parameter-1',
    reportId: 'report-3',
    decision: 'reject',
    reasons: ['evaluation report contains safety findings'],
    decidedAt: capturedAt,
  };
}

describe('applyPromotion', () => {
  it('applies parameter patch to target when gate decision is allow', () => {
    const target = { retrieval: { topK: 5 }, threshold: 0.7 };
    const variant = parameterVariant();
    const decision = allowDecision();

    const record = applyPromotion(target, variant, decision);

    expect(target).toEqual({ retrieval: { topK: 8 }, threshold: 0.7 });
    expect(record).toEqual({
      id: 'promo-variant-parameter-1-gate-variant-parameter-1-report-1',
      variantId: 'variant-parameter-1',
      gateDecisionId: 'gate-variant-parameter-1-report-1',
      appliedAt: capturedAt,
      rollbackPlan: variant.rollbackPlan,
      previousState: { retrieval: { topK: 5 }, threshold: 0.7 },
      nextState: { retrieval: { topK: 8 }, threshold: 0.7 },
    });
  });

  it('does not mutate target when gate decision is needs-review', () => {
    const target = { topK: 5 };
    const variant = parameterVariant();
    const decision = needsReviewDecision();

    const record = applyPromotion(target, variant, decision);

    expect(target).toEqual({ topK: 5 });
    expect(record).toBeNull();
  });

  it('does not mutate target when gate decision is reject', () => {
    const target = { topK: 5 };
    const variant = parameterVariant();
    const decision = rejectDecision();

    const record = applyPromotion(target, variant, decision);

    expect(target).toEqual({ topK: 5 });
    expect(record).toBeNull();
  });
});

describe('rollbackPromotion', () => {
  it('restores target to previous state', () => {
    const target = { retrieval: { topK: 8 }, threshold: 0.7 };
    const record = {
      id: 'promo-variant-parameter-1-gate-variant-parameter-1-report-1',
      variantId: 'variant-parameter-1',
      gateDecisionId: 'gate-variant-parameter-1-report-1',
      appliedAt: capturedAt,
      rollbackPlan: parameterVariant().rollbackPlan,
      previousState: { retrieval: { topK: 5 }, threshold: 0.7 },
      nextState: { retrieval: { topK: 8 }, threshold: 0.7 },
    };

    rollbackPromotion(target, record);

    expect(target).toEqual({ retrieval: { topK: 5 }, threshold: 0.7 });
  });
});
