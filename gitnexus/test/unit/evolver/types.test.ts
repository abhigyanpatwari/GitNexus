import { describe, expect, it } from 'vitest';
import {
  EVOLVER_MUTATION_TYPES,
  type EvaluationReport,
  type GateDecision,
  type MutationType,
  type VariantSpec,
} from '../../../src/core/evolver/index.js';

describe('evolver core types', () => {
  it('supports a fully typed promotable parameter variant', () => {
    const mutationType: MutationType = 'parameter';
    const variant: VariantSpec = {
      id: 'variant-plan-1-parameter',
      planId: 'plan-1',
      mutationType,
      description: 'Increase retrieval topK from 5 to 8',
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
          expectedDelta: 0.08,
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
          reference: 'benchmark/run-1',
          capturedAt: '2026-05-25T00:00:00.000Z',
        },
      ],
    };

    const report: EvaluationReport = {
      id: 'report-1',
      variantId: variant.id,
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
    };

    const gate: GateDecision = {
      id: 'gate-1',
      variantId: variant.id,
      reportId: report.id,
      decision: 'allow',
      reasons: ['parameter variant passed metrics, budget, safety, and rollback checks'],
      decidedAt: '2026-05-25T00:00:01.000Z',
    };

    expect(EVOLVER_MUTATION_TYPES).toEqual(['parameter', 'algorithm', 'structure']);
    expect(variant.mutationType).toBe('parameter');
    expect(report.verdict).toBe('promote');
    expect(gate.decision).toBe('allow');
  });
});
