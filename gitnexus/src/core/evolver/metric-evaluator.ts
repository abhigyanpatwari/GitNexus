import type {
  BaselineProfile,
  EvaluationReport,
  EvaluationVerdict,
  MetricDelta,
  MetricDirection,
  MetricReading,
  MetricTarget,
  RegressionFinding,
  ResourceBudget,
  ResourceUsage,
  SafetyFinding,
  TrialResult,
  VariantSpec,
} from './types.js';

export interface EvaluateVariantInput {
  id: string;
  variant: VariantSpec;
  baseline: BaselineProfile;
  trial: TrialResult;
  targetMetrics: MetricTarget[];
  budget: ResourceBudget;
  safetyFindings: SafetyFinding[];
  rollbackPassed: boolean;
}

export function evaluateVariant(input: EvaluateVariantInput): EvaluationReport {
  const metricDeltas = input.targetMetrics.map((target) =>
    calculateMetricDelta(target, input.baseline.metrics, input.trial.metrics),
  );
  const regressions = input.targetMetrics.flatMap((target) =>
    findRegression(target, input.baseline.metrics, input.trial.metrics),
  );
  const budgetPassed = isWithinBudget(input.trial.resourceUsage, input.budget);
  const metricsPassed = metricDeltas.every((delta) => delta.passed);
  const checksPassed =
    metricsPassed &&
    regressions.length === 0 &&
    budgetPassed &&
    input.safetyFindings.length === 0 &&
    input.rollbackPassed;

  return {
    id: input.id,
    variantId: input.variant.id,
    baselineId: input.baseline.id,
    metricDeltas,
    regressions,
    resourceCost: input.trial.resourceUsage,
    safetyFindings: input.safetyFindings,
    verdict: determineVerdict(input.variant, checksPassed),
  };
}

function determineVerdict(variant: VariantSpec, checksPassed: boolean): EvaluationVerdict {
  if (!checksPassed) {
    return 'reject';
  }

  if (variant.mutationType === 'parameter') {
    return 'promote';
  }

  return 'needs-review';
}

function calculateMetricDelta(
  target: MetricTarget,
  baselineMetrics: MetricReading[],
  trialMetrics: MetricReading[],
): MetricDelta {
  const baselineValue = findMetricValue(target.metricId, baselineMetrics);
  const candidateValue = findMetricValue(target.metricId, trialMetrics);
  const delta = candidateValue - baselineValue;
  const minDelta = target.minDelta ?? 0;
  const passed = isImprovement(delta, target.direction, minDelta);

  return {
    metricId: target.metricId,
    baselineValue,
    candidateValue,
    delta: normalizeDelta(delta),
    direction: target.direction,
    passed,
  };
}

function findRegression(
  target: MetricTarget,
  baselineMetrics: MetricReading[],
  trialMetrics: MetricReading[],
): RegressionFinding[] {
  const baselineValue = findMetricValue(target.metricId, baselineMetrics);
  const candidateValue = findMetricValue(target.metricId, trialMetrics);
  const regressionAmount = calculateRegressionAmount(
    baselineValue,
    candidateValue,
    target.direction,
  );
  const limit = target.maxRegression ?? 0;

  if (regressionAmount <= limit) {
    return [];
  }

  return [
    {
      metricId: target.metricId,
      baselineValue,
      candidateValue,
      regressionAmount: normalizeDelta(regressionAmount),
      limit,
    },
  ];
}

function isImprovement(delta: number, direction: MetricDirection, minDelta: number): boolean {
  if (direction === 'increase') {
    return delta >= minDelta;
  }

  return -delta >= minDelta;
}

function calculateRegressionAmount(
  baselineValue: number,
  candidateValue: number,
  direction: MetricDirection,
): number {
  if (direction === 'increase') {
    return Math.max(0, baselineValue - candidateValue);
  }

  return Math.max(0, candidateValue - baselineValue);
}

function findMetricValue(metricId: string, metrics: MetricReading[]): number {
  const metric = metrics.find((reading) => reading.metricId === metricId);

  if (!metric) {
    return 0;
  }

  return metric.value;
}

function isWithinBudget(usage: ResourceUsage, budget: ResourceBudget): boolean {
  return (
    usage.durationMs <= budget.maxDurationMs &&
    usage.computeUnits <= budget.maxComputeUnits &&
    usage.apiCostUsd <= budget.maxApiCostUsd &&
    usage.storageBytes <= budget.maxStorageBytes
  );
}

function normalizeDelta(value: number): number {
  return Number(value.toFixed(12));
}
