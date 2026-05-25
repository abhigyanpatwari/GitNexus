import type { ResourceBudget, ResourceUsage, VariantSpec } from './types.js';

export interface ResourceUseRequest {
  variant: VariantSpec;
  requestedUsage: ResourceUsage;
  activeRuns: number;
  activeHighRiskVariants: number;
}

export interface ResourceDegradedPlan {
  reduceCandidateCount: boolean;
  pauseLowPriorityGoals: boolean;
  stopNewExploration: boolean;
}

export interface ResourceDecision {
  allowed: boolean;
  reason:
    | 'within-budget'
    | 'duration-budget-exceeded'
    | 'compute-budget-exceeded'
    | 'api-cost-budget-exceeded'
    | 'storage-budget-exceeded'
    | 'concurrency-limit-reached'
    | 'high-risk-variant-quota-exhausted';
  degradedPlan?: ResourceDegradedPlan;
}

export function decideResourceUse(
  request: ResourceUseRequest,
  budget: ResourceBudget,
  currentUsage: ResourceUsage,
): ResourceDecision {
  if (request.activeRuns >= budget.maxConcurrency) {
    return deny('concurrency-limit-reached', {
      reduceCandidateCount: false,
      pauseLowPriorityGoals: true,
      stopNewExploration: false,
    });
  }

  if (
    request.variant.riskLevel === 'high' &&
    request.activeHighRiskVariants >= budget.maxHighRiskVariants
  ) {
    return deny('high-risk-variant-quota-exhausted', {
      reduceCandidateCount: false,
      pauseLowPriorityGoals: false,
      stopNewExploration: true,
    });
  }

  const projectedUsage = addResourceUsage(currentUsage, request.requestedUsage);

  if (projectedUsage.durationMs > budget.maxDurationMs) {
    return deny('duration-budget-exceeded', budgetDegradation());
  }

  if (projectedUsage.computeUnits > budget.maxComputeUnits) {
    return deny('compute-budget-exceeded', budgetDegradation());
  }

  if (projectedUsage.apiCostUsd > budget.maxApiCostUsd) {
    return deny('api-cost-budget-exceeded', budgetDegradation());
  }

  if (projectedUsage.storageBytes > budget.maxStorageBytes) {
    return deny('storage-budget-exceeded', budgetDegradation());
  }

  return {
    allowed: true,
    reason: 'within-budget',
  };
}

function deny(reason: ResourceDecision['reason'], degradedPlan: ResourceDegradedPlan): ResourceDecision {
  return {
    allowed: false,
    reason,
    degradedPlan,
  };
}

function addResourceUsage(currentUsage: ResourceUsage, requestedUsage: ResourceUsage): ResourceUsage {
  return {
    durationMs: currentUsage.durationMs + requestedUsage.durationMs,
    computeUnits: currentUsage.computeUnits + requestedUsage.computeUnits,
    apiCostUsd: currentUsage.apiCostUsd + requestedUsage.apiCostUsd,
    storageBytes: currentUsage.storageBytes + requestedUsage.storageBytes,
  };
}

function budgetDegradation(): ResourceDegradedPlan {
  return {
    reduceCandidateCount: true,
    pauseLowPriorityGoals: false,
    stopNewExploration: false,
  };
}
