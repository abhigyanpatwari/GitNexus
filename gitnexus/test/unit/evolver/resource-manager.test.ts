import { describe, expect, it } from 'vitest';
import { decideResourceUse } from '../../../src/core/evolver/index.js';
import type { ResourceBudget, ResourceUsage, VariantSpec } from '../../../src/core/evolver/index.js';

const budget: ResourceBudget = {
  maxDurationMs: 1000,
  maxComputeUnits: 10,
  maxApiCostUsd: 1,
  maxStorageBytes: 2048,
  maxConcurrency: 2,
  maxHighRiskVariants: 1,
};

const currentUsage: ResourceUsage = {
  durationMs: 100,
  computeUnits: 2,
  apiCostUsd: 0.1,
  storageBytes: 256,
};

function variant(overrides: Partial<VariantSpec> = {}): VariantSpec {
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
        capturedAt: '2026-05-25T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('decideResourceUse', () => {
  it('allows a request when projected resource use stays within budget', () => {
    const decision = decideResourceUse(
      {
        variant: variant(),
        requestedUsage: {
          durationMs: 300,
          computeUnits: 3,
          apiCostUsd: 0.2,
          storageBytes: 512,
        },
        activeRuns: 1,
        activeHighRiskVariants: 0,
      },
      budget,
      currentUsage,
    );

    expect(decision).toEqual({
      allowed: true,
      reason: 'within-budget',
    });
  });

  it('denies a request when projected API cost exceeds budget', () => {
    const decision = decideResourceUse(
      {
        variant: variant(),
        requestedUsage: {
          durationMs: 100,
          computeUnits: 1,
          apiCostUsd: 1,
          storageBytes: 128,
        },
        activeRuns: 0,
        activeHighRiskVariants: 0,
      },
      budget,
      currentUsage,
    );

    expect(decision).toEqual({
      allowed: false,
      reason: 'api-cost-budget-exceeded',
      degradedPlan: {
        reduceCandidateCount: true,
        pauseLowPriorityGoals: false,
        stopNewExploration: false,
      },
    });
  });

  it('denies a request when concurrency limit is reached', () => {
    const decision = decideResourceUse(
      {
        variant: variant(),
        requestedUsage: {
          durationMs: 100,
          computeUnits: 1,
          apiCostUsd: 0,
          storageBytes: 128,
        },
        activeRuns: 2,
        activeHighRiskVariants: 0,
      },
      budget,
      currentUsage,
    );

    expect(decision).toEqual({
      allowed: false,
      reason: 'concurrency-limit-reached',
      degradedPlan: {
        reduceCandidateCount: false,
        pauseLowPriorityGoals: true,
        stopNewExploration: false,
      },
    });
  });

  it('denies a high-risk request when high-risk quota is exhausted', () => {
    const decision = decideResourceUse(
      {
        variant: variant({
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
        }),
        requestedUsage: {
          durationMs: 100,
          computeUnits: 1,
          apiCostUsd: 0,
          storageBytes: 128,
        },
        activeRuns: 0,
        activeHighRiskVariants: 1,
      },
      budget,
      currentUsage,
    );

    expect(decision).toEqual({
      allowed: false,
      reason: 'high-risk-variant-quota-exhausted',
      degradedPlan: {
        reduceCandidateCount: false,
        pauseLowPriorityGoals: false,
        stopNewExploration: true,
      },
    });
  });
});
