import { describe, expect, it } from 'vitest';
import { generateVariants } from '../../../src/core/evolver/index.js';
import type { EvolutionPlan, ResourceBudget } from '../../../src/core/evolver/index.js';

const resourceBudget: ResourceBudget = {
  maxDurationMs: 1000,
  maxComputeUnits: 10,
  maxApiCostUsd: 1,
  maxStorageBytes: 2048,
  maxConcurrency: 2,
  maxHighRiskVariants: 1,
};

const plan: EvolutionPlan = {
  id: 'plan-1',
  goalId: 'goal-1',
  hypothesis: 'Adjust retrieval and ranking strategy to improve task success rate',
  targetObject: {
    id: 'retrieval-policy',
    kind: 'parameter-set',
    description: 'Retrieval policy parameters and selection strategy',
  },
  allowedMutationTypes: ['parameter', 'algorithm', 'structure'],
  evaluationProtocolId: 'protocol-1',
  resourceBudget,
};

describe('generateVariants', () => {
  it('generates deterministic parameter, algorithm, and structure variants with risk and rollback data', () => {
    const variants = generateVariants(plan, {
      'retrieval.topK': 5,
      'ranking.algorithm': 'baseline-ranker',
    });

    expect(variants).toHaveLength(3);
    expect(variants.map((variant) => variant.id)).toEqual([
      'plan-1-parameter-variant',
      'plan-1-algorithm-variant',
      'plan-1-structure-variant',
    ]);
    expect(variants.map((variant) => variant.mutationType)).toEqual([
      'parameter',
      'algorithm',
      'structure',
    ]);
    expect(variants.map((variant) => variant.riskLevel)).toEqual(['low', 'medium', 'high']);
    expect(variants.map((variant) => variant.rollbackPlan.strategy)).toEqual([
      'restore-previous-parameters',
      'disable-candidate',
      'manual-review-required',
    ]);
    expect(variants.every((variant) => variant.provenance.length === 1)).toBe(true);
    expect(variants.every((variant) => variant.provenance[0]?.source === 'evolver-variant-generator')).toBe(
      true,
    );
  });

  it('only generates mutation types allowed by the plan', () => {
    const variants = generateVariants(
      {
        ...plan,
        allowedMutationTypes: ['parameter'],
      },
      {
        'retrieval.topK': 5,
        'ranking.algorithm': 'baseline-ranker',
      },
    );

    expect(variants).toHaveLength(1);
    expect(variants[0]?.mutationType).toBe('parameter');
    expect(variants[0]?.patch.operations).toEqual([
      {
        op: 'setParameter',
        path: 'retrieval.topK',
        previousValue: 5,
        nextValue: 6,
      },
    ]);
  });
});
