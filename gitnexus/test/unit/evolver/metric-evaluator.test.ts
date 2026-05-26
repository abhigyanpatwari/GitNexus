import { describe, expect, it } from 'vitest';
import { evaluateVariant } from '../../../src/core/evolver/index.js';
import type {
  BaselineProfile,
  MetricTarget,
  ResourceBudget,
  SafetyFinding,
  TrialResult,
  VariantSpec,
} from '../../../src/core/evolver/index.js';

const capturedAt = '2026-05-25T00:00:00.000Z';

function baselineProfile(metricValue = 0.72): BaselineProfile {
  return {
    id: 'baseline-1',
    goalId: 'goal-1',
    capturedAt,
    metrics: [
      {
        metricId: 'task_success_rate',
        value: metricValue,
        capturedAt,
      },
    ],
    resourceUsage: {
      durationMs: 100,
      computeUnits: 1,
      apiCostUsd: 0,
      storageBytes: 128,
    },
  };
}

function parameterVariant(overrides: Partial<VariantSpec> = {}): VariantSpec {
  return {
    id: 'variant-parameter-1',
    planId: 'plan-1',
    mutationType: 'parameter',
    description: 'Increase retrieval topK',
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

function trialResult(candidateValue: number, overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    id: 'trial-1',
    variantId: 'variant-parameter-1',
    protocolId: 'protocol-1',
    metrics: [
      {
        metricId: 'task_success_rate',
        value: candidateValue,
        capturedAt,
      },
    ],
    resourceUsage: {
      durationMs: 120,
      computeUnits: 1,
      apiCostUsd: 0,
      storageBytes: 256,
    },
    errors: [],
    completedAt: capturedAt,
    ...overrides,
  };
}

const targetMetrics: MetricTarget[] = [
  {
    metricId: 'task_success_rate',
    direction: 'increase',
    minDelta: 0.05,
    maxRegression: 0.01,
  },
];

const budget: ResourceBudget = {
  maxDurationMs: 1000,
  maxComputeUnits: 10,
  maxApiCostUsd: 1,
  maxStorageBytes: 1024,
  maxConcurrency: 1,
  maxHighRiskVariants: 0,
};

describe('evaluateVariant', () => {
  it('promotes a parameter variant when metrics improve and checks pass', () => {
    const report = evaluateVariant({
      id: 'report-1',
      variant: parameterVariant(),
      baseline: baselineProfile(),
      trial: trialResult(0.81),
      targetMetrics,
      budget,
      safetyFindings: [],
      rollbackPassed: true,
    });

    expect(report.verdict).toBe('promote');
    expect(report.metricDeltas).toEqual([
      {
        metricId: 'task_success_rate',
        baselineValue: 0.72,
        candidateValue: 0.81,
        delta: 0.09,
        direction: 'increase',
        passed: true,
      },
    ]);
    expect(report.regressions).toEqual([]);
  });

  it('rejects a variant when a target metric regresses beyond the configured limit', () => {
    const report = evaluateVariant({
      id: 'report-2',
      variant: parameterVariant(),
      baseline: baselineProfile(),
      trial: trialResult(0.68),
      targetMetrics,
      budget,
      safetyFindings: [],
      rollbackPassed: true,
    });

    expect(report.verdict).toBe('reject');
    expect(report.metricDeltas[0]?.passed).toBe(false);
    expect(report.regressions).toEqual([
      {
        metricId: 'task_success_rate',
        baselineValue: 0.72,
        candidateValue: 0.68,
        regressionAmount: 0.04,
        limit: 0.01,
      },
    ]);
  });

  it('rejects a variant when safety findings are present', () => {
    const safetyFindings: SafetyFinding[] = [
      {
        id: 'safety-1',
        severity: 'high',
        message: 'unsafe action attempted',
      },
    ];

    const report = evaluateVariant({
      id: 'report-3',
      variant: parameterVariant(),
      baseline: baselineProfile(),
      trial: trialResult(0.81),
      targetMetrics,
      budget,
      safetyFindings,
      rollbackPassed: true,
    });

    expect(report.verdict).toBe('reject');
    expect(report.safetyFindings).toBe(safetyFindings);
  });

  it('rejects a variant when resource cost exceeds the configured budget', () => {
    const report = evaluateVariant({
      id: 'report-budget',
      variant: parameterVariant(),
      baseline: baselineProfile(),
      trial: trialResult(0.81, {
        resourceUsage: {
          durationMs: 1200,
          computeUnits: 1,
          apiCostUsd: 0,
          storageBytes: 256,
        },
      }),
      targetMetrics,
      budget,
      safetyFindings: [],
      rollbackPassed: true,
    });

    expect(report.verdict).toBe('reject');
    expect(report.resourceCost.durationMs).toBe(1200);
  });

  it('rejects a variant when rollback validation fails', () => {
    const report = evaluateVariant({
      id: 'report-rollback',
      variant: parameterVariant(),
      baseline: baselineProfile(),
      trial: trialResult(0.81),
      targetMetrics,
      budget,
      safetyFindings: [],
      rollbackPassed: false,
    });

    expect(report.verdict).toBe('reject');
    expect(report.metricDeltas[0]?.passed).toBe(true);
  });

  it('marks an algorithm variant as needs-review even when metrics improve', () => {
    const algorithmVariant = parameterVariant({
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

    const report = evaluateVariant({
      id: 'report-4',
      variant: algorithmVariant,
      baseline: baselineProfile(),
      trial: trialResult(0.83, { variantId: algorithmVariant.id }),
      targetMetrics,
      budget,
      safetyFindings: [],
      rollbackPassed: true,
    });

    expect(report.verdict).toBe('needs-review');
    expect(report.metricDeltas[0]?.passed).toBe(true);
  });
});
