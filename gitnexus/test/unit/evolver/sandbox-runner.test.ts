import { describe, expect, it } from 'vitest';
import { runSandboxTrial } from '../../../src/core/evolver/index.js';
import type { ResourceBudget, VariantSpec } from '../../../src/core/evolver/index.js';

const capturedAt = '2026-05-25T00:00:00.000Z';

const budget: ResourceBudget = {
  maxDurationMs: 1000,
  maxComputeUnits: 10,
  maxApiCostUsd: 1,
  maxStorageBytes: 2048,
  maxConcurrency: 2,
  maxHighRiskVariants: 1,
};

const variant: VariantSpec = {
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

describe('runSandboxTrial', () => {
  it('records a successful sandbox trial from an injected runner', async () => {
    const result = await runSandboxTrial(
      variant,
      { id: 'protocol-1', maxDurationMs: 1000 },
      async () => ({
        metrics: [
          {
            metricId: 'task_success_rate',
            value: 0.82,
            capturedAt,
          },
        ],
        resourceUsage: {
          durationMs: 120,
          computeUnits: 1,
          apiCostUsd: 0,
          storageBytes: 256,
        },
      }),
      budget,
    );

    expect(result).toEqual({
      id: 'trial-variant-parameter-1-protocol-1',
      variantId: 'variant-parameter-1',
      protocolId: 'protocol-1',
      metrics: [
        {
          metricId: 'task_success_rate',
          value: 0.82,
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
    });
  });

  it('records runner failures as trial errors without throwing', async () => {
    const result = await runSandboxTrial(
      variant,
      { id: 'protocol-1', maxDurationMs: 1000 },
      async () => {
        throw new Error('sandbox failure');
      },
      budget,
    );

    expect(result.variantId).toBe('variant-parameter-1');
    expect(result.metrics).toEqual([]);
    expect(result.errors).toEqual([
      {
        id: 'error-trial-variant-parameter-1-protocol-1',
        type: 'temporary-failure',
        message: 'sandbox failure',
        occurredAt: capturedAt,
        variantId: 'variant-parameter-1',
      },
    ]);
  });

  it('rejects a trial before running when protocol duration exceeds budget', async () => {
    let runnerCalled = false;

    const result = await runSandboxTrial(
      variant,
      { id: 'protocol-1', maxDurationMs: 1500 },
      async () => {
        runnerCalled = true;
        return {
          metrics: [],
          resourceUsage: {
            durationMs: 1,
            computeUnits: 1,
            apiCostUsd: 0,
            storageBytes: 0,
          },
        };
      },
      budget,
    );

    expect(runnerCalled).toBe(false);
    expect(result.errors).toEqual([
      {
        id: 'error-trial-variant-parameter-1-protocol-1',
        type: 'resource-exhaustion',
        message: 'sandbox protocol duration budget exceeded',
        occurredAt: capturedAt,
        variantId: 'variant-parameter-1',
      },
    ]);
  });
});
