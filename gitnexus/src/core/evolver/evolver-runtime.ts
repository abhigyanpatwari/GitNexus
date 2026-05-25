import type {
  BaselineProfile,
  EnvironmentSnapshot,
  EvaluationReport,
  EvolutionPlan,
  GateDecision,
  GoalSpec,
  MutationType,
  PromotionRecord,
  ResourceBudget,
  TrialResult,
  VariantSpec,
} from './types.js';
import type { SandboxRunner } from './sandbox-runner.js';
import type { InMemoryEvolutionMemory } from './evolution-memory.js';
import { applyPromotion } from './promotion-controller.js';
import { decidePromotion } from './safety-gate.js';
import { decideResourceUse } from './resource-manager.js';
import { evaluateVariant } from './metric-evaluator.js';
import { generateVariants } from './variant-generator.js';
import { runSandboxTrial } from './sandbox-runner.js';

export interface EvolverRuntimeConfig {
  memory: InMemoryEvolutionMemory;
  sandboxRunner: SandboxRunner;
  currentParameters: Record<string, unknown>;
  allowedMutationTypes?: MutationType[];
}

export interface EvolverRuntimeResult {
  promotionRecord: PromotionRecord | null;
  gateDecision: GateDecision;
  evaluationReport: EvaluationReport;
  trialResult: TrialResult;
}

export interface EvolverRuntime {
  runEvolution(
    goal: GoalSpec,
    snapshot: EnvironmentSnapshot,
    baseline: BaselineProfile,
  ): Promise<EvolverRuntimeResult>;
}

export function createEvolverRuntime(config: EvolverRuntimeConfig): EvolverRuntime {
  return {
    async runEvolution(
      goal: GoalSpec,
      snapshot: EnvironmentSnapshot,
      baseline: BaselineProfile,
    ): Promise<EvolverRuntimeResult> {
      const plan = buildPlan(goal, config.allowedMutationTypes);
      const variants = generateVariants(plan, config.currentParameters);

      const variant = variants[0];

      memoryAdd(config.memory, 'variant', variant.id, goal.id, `Generated ${variant.mutationType} variant`, variant);

      const protocol = { id: `${plan.id}-protocol`, maxDurationMs: plan.resourceBudget.maxDurationMs };

      const resourceDecision = decideResourceUse(
        {
          variant,
          requestedUsage: {
            durationMs: protocol.maxDurationMs,
            computeUnits: 1,
            apiCostUsd: 0,
            storageBytes: 256,
          },
          activeRuns: 1,
          activeHighRiskVariants: variant.riskLevel === 'high' ? 1 : 0,
        },
        plan.resourceBudget,
        snapshot.resourceUsage,
      );

      if (!resourceDecision.allowed) {
        const failedTrial = buildResourceDeniedTrial(variant, protocol);
        memoryAdd(config.memory, 'trial', variant.id, goal.id, 'Resource denied', failedTrial);
        const report = buildRejectedReport(variant, baseline, 'resource denied');
        const gate = decidePromotion(variant, report);
        return { promotionRecord: null, gateDecision: gate, evaluationReport: report, trialResult: failedTrial };
      }

      const trial = await runSandboxTrial(variant, protocol, config.sandboxRunner, plan.resourceBudget);
      memoryAdd(config.memory, 'trial', variant.id, goal.id, `Trial completed with ${trial.errors.length} errors`, trial);

      const report = evaluateVariant({
        id: `evaluation-${variant.id}`,
        variant,
        baseline,
        trial,
        targetMetrics: goal.targetMetrics,
        budget: plan.resourceBudget,
        safetyFindings: extractSafetyFindings(snapshot),
        rollbackPassed: variant.mutationType === 'structure' || variant.rollbackPlan.operations.length > 0,
      });
      memoryAdd(config.memory, 'evaluation', variant.id, goal.id, `Verdict: ${report.verdict}`, report);

      const gate = decidePromotion(variant, report);
      memoryAdd(config.memory, 'gate', variant.id, goal.id, `Decision: ${gate.decision}`, gate);

      let promotionRecord: PromotionRecord | null = null;
      if (gate.decision === 'allow') {
        promotionRecord = applyPromotion(config.currentParameters, variant, gate);
        if (promotionRecord) {
          memoryAdd(config.memory, 'promotion', variant.id, goal.id, 'Variant promoted', promotionRecord);
        }
      }

      return { promotionRecord, gateDecision: gate, evaluationReport: report, trialResult: trial };
    },
  };
}

function buildPlan(goal: GoalSpec, allowedMutationTypes?: MutationType[]): EvolutionPlan {
  return {
    id: `plan-${goal.id}`,
    goalId: goal.id,
    hypothesis: `Evolve towards ${goal.objective}`,
    targetObject: {
      id: `target-${goal.id}`,
      kind: 'parameter-set',
      description: goal.objective,
    },
    allowedMutationTypes: allowedMutationTypes ?? ['parameter'],
    evaluationProtocolId: `protocol-${goal.id}`,
    resourceBudget: defaultBudget(),
  };
}

function defaultBudget(): ResourceBudget {
  return {
    maxDurationMs: 5000,
    maxComputeUnits: 100,
    maxApiCostUsd: 10,
    maxStorageBytes: 10240,
    maxConcurrency: 4,
    maxHighRiskVariants: 2,
  };
}

function extractSafetyFindings(snapshot: EnvironmentSnapshot) {
  return snapshot.signals
    .filter((s) => s.kind === 'safety')
    .map((s) => ({ id: s.id, severity: s.severity, message: s.description }));
}

function buildResourceDeniedTrial(variant: VariantSpec, protocol: { id: string }): TrialResult {
  return {
    id: `trial-${variant.id}-${protocol.id}`,
    variantId: variant.id,
    protocolId: protocol.id,
    metrics: [],
    resourceUsage: { durationMs: 0, computeUnits: 0, apiCostUsd: 0, storageBytes: 0 },
    errors: [
      {
        id: `error-trial-${variant.id}-${protocol.id}`,
        type: 'resource-exhaustion',
        message: 'resource request denied',
        occurredAt: '2026-05-25T00:00:00.000Z',
        variantId: variant.id,
      },
    ],
    completedAt: '2026-05-25T00:00:00.000Z',
  };
}

function buildRejectedReport(variant: VariantSpec, baseline: BaselineProfile, reason: string): EvaluationReport {
  return {
    id: `evaluation-${variant.id}`,
    variantId: variant.id,
    baselineId: baseline.id,
    metricDeltas: [],
    regressions: [],
    resourceCost: { durationMs: 0, computeUnits: 0, apiCostUsd: 0, storageBytes: 0 },
    safetyFindings: [{ id: `safety-${variant.id}`, severity: 'high', message: reason }],
    verdict: 'reject',
  };
}

function memoryAdd(
  memory: InMemoryEvolutionMemory,
  kind: 'variant' | 'trial' | 'evaluation' | 'gate' | 'promotion',
  variantId: string,
  goalId: string,
  summary: string,
  payload: unknown,
): void {
  memory.add({
    id: `mem-${kind}-${variantId}`,
    variantId,
    goalId,
    kind,
    summary,
    createdAt: '2026-05-25T00:00:00.000Z',
    payload,
  });
}
