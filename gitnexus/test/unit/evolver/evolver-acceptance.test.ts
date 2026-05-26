import { describe, expect, it } from 'vitest';
import {
  createEvolverRuntime,
  decidePromotion,
  evaluateVariant,
  generateVariants,
  selectCorrectionAction,
  applyPromotion,
  rollbackPromotion,
  InMemoryEvolutionMemory,
} from '../../../src/core/evolver/index.js';
import type {
  BaselineProfile,
  CorrectionAction,
  EnvironmentSnapshot,
  EvaluationReport,
  GateDecision,
  GoalSpec,
  MetricTarget,
  PromotionRecord,
  ResourceBudget,
  SandboxRunner,
  VariantSpec,
} from '../../../src/core/evolver/index.js';

const capturedAt = '2026-05-25T00:00:00.000Z';

const goal: GoalSpec = {
  id: 'acceptance-goal',
  name: 'Improve task success rate',
  objective: 'Increase task success rate via parameter tuning',
  priority: 1,
  targetMetrics: [
    {
      metricId: 'task_success_rate',
      direction: 'increase',
      minDelta: 0.03,
      maxRegression: 0.02,
    },
  ],
  constraints: [],
  stopConditions: ['task_success_rate >= 0.90'],
};

const baseline: BaselineProfile = {
  id: 'acceptance-baseline',
  goalId: 'acceptance-goal',
  capturedAt,
  metrics: [{ metricId: 'task_success_rate', value: 0.72, capturedAt }],
  resourceUsage: { durationMs: 0, computeUnits: 0, apiCostUsd: 0, storageBytes: 0 },
};

const snapshot: EnvironmentSnapshot = {
  id: 'acceptance-snapshot',
  capturedAt,
  signals: [],
  performance: [{ metricId: 'task_success_rate', value: 0.72, capturedAt }],
  errors: [],
  resourceUsage: { durationMs: 0, computeUnits: 0, apiCostUsd: 0, storageBytes: 0 },
};

const budget: ResourceBudget = {
  maxDurationMs: 5000,
  maxComputeUnits: 100,
  maxApiCostUsd: 10,
  maxStorageBytes: 10240,
  maxConcurrency: 4,
  maxHighRiskVariants: 2,
};

function successSandboxRunner(): SandboxRunner {
  return async () => ({
    metrics: [{ metricId: 'task_success_rate', value: 0.82, capturedAt }],
    resourceUsage: { durationMs: 120, computeUnits: 1, apiCostUsd: 0, storageBytes: 256 },
  });
}

function degradedSandboxRunner(): SandboxRunner {
  return async () => ({
    metrics: [{ metricId: 'task_success_rate', value: 0.60, capturedAt }],
    resourceUsage: { durationMs: 120, computeUnits: 1, apiCostUsd: 0, storageBytes: 256 },
  });
}

describe('Evolver acceptance', () => {
  it('discovers improvement need from metrics gap', () => {
    const targetMetrics = goal.targetMetrics;
    const baselineValue = baseline.metrics.find(
      (m) => m.metricId === targetMetrics[0].metricId,
    )!.value;
    const targetDirection = targetMetrics[0].direction;
    const minDelta = targetMetrics[0].minDelta;

    const gapExists =
      targetDirection === 'increase'
        ? baselineValue < 1 - minDelta
        : baselineValue > minDelta;

    expect(gapExists).toBe(true);
    expect(baselineValue).toBeLessThan(0.90);
  });

  it('generates parameter, algorithm and structure variants from a plan', () => {
    const currentParameters = { 'retrieval.topK': 5, 'ranking.algorithm': 'baseline-ranker' };
    const plan = {
      id: 'plan-acceptance',
      goalId: 'acceptance-goal',
      hypothesis: 'Test hypothesis',
      targetObject: { id: 'target-1', kind: 'parameter-set', description: 'test' },
      allowedMutationTypes: ['parameter', 'algorithm', 'structure'] as const,
      evaluationProtocolId: 'protocol-1',
      resourceBudget: budget,
    };

    const variants = generateVariants(plan, currentParameters);

    expect(variants).toHaveLength(3);
    const mutationTypes = variants.map((v) => v.mutationType);
    expect(mutationTypes).toContain('parameter');
    expect(mutationTypes).toContain('algorithm');
    expect(mutationTypes).toContain('structure');
  });

  it('sandbox evaluates a variant and produces a trial result', async () => {
    const currentParameters = { 'retrieval.topK': 5 };
    const plan = {
      id: 'plan-sandbox',
      goalId: 'acceptance-goal',
      hypothesis: 'Test',
      targetObject: { id: 'target-1', kind: 'parameter-set', description: 'test' },
      allowedMutationTypes: ['parameter'] as const,
      evaluationProtocolId: 'protocol-1',
      resourceBudget: budget,
    };
    const variants = generateVariants(plan, currentParameters);
    const variant = variants[0];

    const runner = successSandboxRunner();
    const protocol = { id: 'protocol-sandbox', maxDurationMs: 5000 };
    const { runSandboxTrial } = await import('../../../src/core/evolver/index.js');
    const trial = await runSandboxTrial(variant, protocol, runner, budget);

    expect(trial.metrics.length).toBeGreaterThan(0);
    expect(trial.metrics[0].metricId).toBe('task_success_rate');
    expect(trial.metrics[0].value).toBe(0.82);
  });

  it('auto-applies low-risk parameter change when metrics improve', async () => {
    const memory = new InMemoryEvolutionMemory();
    const currentParameters = { retrieval: { topK: 5 } };

    const runtime = createEvolverRuntime({
      memory,
      sandboxRunner: successSandboxRunner(),
      currentParameters,
    });

    const result = await runtime.runEvolution(goal, snapshot, baseline);

    expect(result.gateDecision.decision).toBe('allow');
    expect(result.promotionRecord).not.toBeNull();
    expect(currentParameters.retrieval.topK).toBe(6);

    const promotions = memory.queryByKind('promotion');
    expect(promotions.length).toBe(1);
  });

  it('blocks structure variant from auto-application', async () => {
    const memory = new InMemoryEvolutionMemory();
    const currentParameters = { retrieval: { topK: 5 } };

    const runtime = createEvolverRuntime({
      memory,
      sandboxRunner: successSandboxRunner(),
      currentParameters,
      allowedMutationTypes: ['structure'],
    });

    const result = await runtime.runEvolution(goal, snapshot, baseline);

    expect(result.gateDecision.decision).toBe('needs-review');
    expect(result.promotionRecord).toBeNull();
    expect(currentParameters.retrieval.topK).toBe(5);
  });

  it('records audit memory for every evolution step', async () => {
    const memory = new InMemoryEvolutionMemory();
    const currentParameters = { retrieval: { topK: 5 } };

    const runtime = createEvolverRuntime({
      memory,
      sandboxRunner: successSandboxRunner(),
      currentParameters,
    });

    await runtime.runEvolution(goal, snapshot, baseline);

    const variants = memory.queryByKind('variant');
    const trials = memory.queryByKind('trial');
    const evaluations = memory.queryByKind('evaluation');
    const gates = memory.queryByKind('gate');

    expect(variants.length).toBeGreaterThanOrEqual(1);
    expect(trials.length).toBeGreaterThanOrEqual(1);
    expect(evaluations.length).toBeGreaterThanOrEqual(1);
    expect(gates.length).toBeGreaterThanOrEqual(1);
  });

  it('selects rollback correction after parameter degradation', async () => {
    const memory = new InMemoryEvolutionMemory();
    const currentParameters = { retrieval: { topK: 5 } };

    const runtime = createEvolverRuntime({
      memory,
      sandboxRunner: degradedSandboxRunner(),
      currentParameters,
    });

    const result = await runtime.runEvolution(goal, snapshot, baseline);

    expect(result.gateDecision.decision).toBe('reject');
    expect(currentParameters.retrieval.topK).toBe(5);

    const degradationError = {
      id: 'error-degradation-1',
      type: 'parameter-degradation' as const,
      message: 'Parameter change caused performance degradation',
      occurredAt: capturedAt,
      variantId: result.evaluationReport.variantId,
    };

    const correction = selectCorrectionAction(degradationError);
    expect(correction.type).toBe('rollback-parameters');
    expect(correction.errorEventId).toBe('error-degradation-1');
  });

  it('can rollback a promoted parameter change', async () => {
    const memory = new InMemoryEvolutionMemory();
    const currentParameters = { retrieval: { topK: 5 } };

    const runtime = createEvolverRuntime({
      memory,
      sandboxRunner: successSandboxRunner(),
      currentParameters,
    });

    const result = await runtime.runEvolution(goal, snapshot, baseline);
    expect(currentParameters.retrieval.topK).toBe(6);

    const record = result.promotionRecord!;
    rollbackPromotion(currentParameters, record);
    expect(currentParameters.retrieval.topK).toBe(5);
  });

  it('rejects variant that causes regression', async () => {
    const memory = new InMemoryEvolutionMemory();
    const currentParameters = { retrieval: { topK: 5 } };

    const runtime = createEvolverRuntime({
      memory,
      sandboxRunner: degradedSandboxRunner(),
      currentParameters,
    });

    const result = await runtime.runEvolution(goal, snapshot, baseline);

    expect(result.evaluationReport.verdict).toBe('reject');
    expect(result.evaluationReport.regressions.length).toBeGreaterThan(0);
  });
});
