import type {
  EvolutionPlan,
  MetricExpectation,
  MutationType,
  RollbackPlan,
  VariantPatch,
  VariantProvenance,
  VariantSpec,
} from './types.js';

export type CurrentParameters = Record<string, unknown>;

const generatedAt = '2026-05-25T00:00:00.000Z';

export function generateVariants(
  plan: EvolutionPlan,
  currentParameters: CurrentParameters,
): VariantSpec[] {
  return plan.allowedMutationTypes.map((mutationType) =>
    buildVariant(plan, currentParameters, mutationType),
  );
}

function buildVariant(
  plan: EvolutionPlan,
  currentParameters: CurrentParameters,
  mutationType: MutationType,
): VariantSpec {
  const expectedGain = defaultExpectedGain();

  return {
    id: `${plan.id}-${mutationType}-variant`,
    planId: plan.id,
    mutationType,
    description: describeVariant(plan, mutationType),
    patch: buildPatch(currentParameters, mutationType),
    expectedGain,
    riskLevel: riskForMutationType(mutationType),
    rollbackPlan: buildRollbackPlan(currentParameters, mutationType),
    provenance: buildProvenance(plan, mutationType),
  };
}

function describeVariant(plan: EvolutionPlan, mutationType: MutationType): string {
  if (mutationType === 'parameter') {
    return `Parameter variant for ${plan.targetObject.id}`;
  }

  if (mutationType === 'algorithm') {
    return `Algorithm variant for ${plan.targetObject.id}`;
  }

  return `Structure review variant for ${plan.targetObject.id}`;
}

function buildPatch(currentParameters: CurrentParameters, mutationType: MutationType): VariantPatch {
  if (mutationType === 'parameter') {
    const previousValue = currentParameters['retrieval.topK'] ?? 5;
    const nextValue = typeof previousValue === 'number' ? previousValue + 1 : 6;

    return {
      operations: [
        {
          op: 'setParameter',
          path: 'retrieval.topK',
          previousValue,
          nextValue,
        },
      ],
    };
  }

  if (mutationType === 'algorithm') {
    const previousAlgorithm = String(currentParameters['ranking.algorithm'] ?? 'baseline-ranker');

    return {
      operations: [
        {
          op: 'selectAlgorithm',
          policyId: 'ranking-policy',
          previousAlgorithm,
          nextAlgorithm: 'candidate-ranker',
        },
      ],
    };
  }

  return {
    operations: [
      {
        op: 'proposeStructureChange',
        planPath: 'docs/aegis/plans/structure-change.md',
        summary: 'Review structure-level evolution before applying changes',
      },
    ],
  };
}

function buildRollbackPlan(
  currentParameters: CurrentParameters,
  mutationType: MutationType,
): RollbackPlan {
  if (mutationType === 'parameter') {
    const previousValue = currentParameters['retrieval.topK'] ?? 5;
    const candidateValue = typeof previousValue === 'number' ? previousValue + 1 : 6;

    return {
      strategy: 'restore-previous-parameters',
      operations: [
        {
          op: 'setParameter',
          path: 'retrieval.topK',
          previousValue: candidateValue,
          nextValue: previousValue,
        },
      ],
    };
  }

  if (mutationType === 'algorithm') {
    const previousAlgorithm = String(currentParameters['ranking.algorithm'] ?? 'baseline-ranker');

    return {
      strategy: 'disable-candidate',
      operations: [
        {
          op: 'selectAlgorithm',
          policyId: 'ranking-policy',
          previousAlgorithm: 'candidate-ranker',
          nextAlgorithm: previousAlgorithm,
        },
      ],
    };
  }

  return {
    strategy: 'manual-review-required',
    operations: [],
  };
}

function riskForMutationType(mutationType: MutationType): VariantSpec['riskLevel'] {
  if (mutationType === 'parameter') {
    return 'low';
  }

  if (mutationType === 'algorithm') {
    return 'medium';
  }

  return 'high';
}

function defaultExpectedGain(): MetricExpectation[] {
  return [
    {
      metricId: 'task_success_rate',
      expectedDelta: 0.05,
      direction: 'increase',
    },
  ];
}

function buildProvenance(plan: EvolutionPlan, mutationType: MutationType): VariantProvenance[] {
  return [
    {
      source: 'evolver-variant-generator',
      reference: `${plan.id}:${mutationType}`,
      capturedAt: generatedAt,
    },
  ];
}
