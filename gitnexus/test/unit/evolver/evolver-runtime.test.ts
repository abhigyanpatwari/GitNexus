import { describe, expect, it } from 'vitest';
import { createEvolverRuntime } from '../../../src/core/evolver/index.js';
import type {
  BaselineProfile,
  EnvironmentSnapshot,
  GoalSpec,
  InMemoryEvolutionMemory,
  SandboxRunner,
} from '../../../src/core/evolver/index.js';

const capturedAt = '2026-05-25T00:00:00.000Z';

const goal: GoalSpec = {
  id: 'goal-1',
  name: 'Improve retrieval accuracy',
  objective: 'Increase task success rate by adjusting retrieval parameters',
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
  id: 'baseline-1',
  goalId: 'goal-1',
  capturedAt,
  metrics: [
    { metricId: 'task_success_rate', value: 0.72, capturedAt },
  ],
  resourceUsage: { durationMs: 0, computeUnits: 0, apiCostUsd: 0, storageBytes: 0 },
};

const snapshot: EnvironmentSnapshot = {
  id: 'snapshot-1',
  capturedAt,
  signals: [],
  performance: [{ metricId: 'task_success_rate', value: 0.72, capturedAt }],
  errors: [],
  resourceUsage: { durationMs: 0, computeUnits: 0, apiCostUsd: 0, storageBytes: 0 },
};

function successRunner(): SandboxRunner {
  return async (variant, protocol) => ({
    metrics: [
      { metricId: 'task_success_rate', value: 0.82, capturedAt },
    ],
    resourceUsage: { durationMs: 120, computeUnits: 1, apiCostUsd: 0, storageBytes: 256 },
  });
}

function regressionRunner(): SandboxRunner {
  return async (variant, protocol) => ({
    metrics: [
      { metricId: 'task_success_rate', value: 0.60, capturedAt },
    ],
    resourceUsage: { durationMs: 120, computeUnits: 1, apiCostUsd: 0, storageBytes: 256 },
  });
}

describe('createEvolverRuntime', () => {
  it('promotes a safe parameter variant and updates target parameters', async () => {
    const memory: InMemoryEvolutionMemory = new (await import('../../../src/core/evolver/index.js')).InMemoryEvolutionMemory();
    const currentParameters = { retrieval: { topK: 5 } };

    const runtime = createEvolverRuntime({
      memory,
      sandboxRunner: successRunner(),
      currentParameters,
    });

    const result = await runtime.runEvolution(goal, snapshot, baseline);

    expect(result.promotionRecord).not.toBeNull();
    expect(result.promotionRecord!.variantId).toContain('parameter');
    expect(currentParameters.retrieval.topK).toBe(6);
    expect(result.gateDecision.decision).toBe('allow');

    const memoryRecords = memory.queryByKind('variant');
    expect(memoryRecords.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects a regressive variant without mutating target', async () => {
    const { InMemoryEvolutionMemory: Mem } = await import('../../../src/core/evolver/index.js');
    const memory = new Mem();
    const currentParameters = { retrieval: { topK: 5 } };

    const runtime = createEvolverRuntime({
      memory,
      sandboxRunner: regressionRunner(),
      currentParameters,
    });

    const result = await runtime.runEvolution(goal, snapshot, baseline);

    expect(result.gateDecision.decision).toBe('reject');
    expect(currentParameters.retrieval.topK).toBe(5);
  });

  it('returns needs-review for structure variant', async () => {
    const { InMemoryEvolutionMemory: Mem } = await import('../../../src/core/evolver/index.js');
    const memory = new Mem();
    const currentParameters = { retrieval: { topK: 5 } };

    const structureGoal: GoalSpec = {
      ...goal,
      id: 'goal-structure',
      constraints: [],
      stopConditions: [],
    };

    const runtime = createEvolverRuntime({
      memory,
      sandboxRunner: successRunner(),
      currentParameters,
      allowedMutationTypes: ['structure'],
    });

    const result = await runtime.runEvolution(structureGoal, snapshot, baseline);

    expect(result.gateDecision.decision).toBe('needs-review');
    expect(currentParameters.retrieval.topK).toBe(5);
  });
});
