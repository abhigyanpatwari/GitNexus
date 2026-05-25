export const EVOLVER_MUTATION_TYPES = ['parameter', 'algorithm', 'structure'] as const;

export type MutationType = (typeof EVOLVER_MUTATION_TYPES)[number];

export type MetricDirection = 'increase' | 'decrease';

export type RiskLevel = 'low' | 'medium' | 'high';

export type EvaluationVerdict = 'promote' | 'reject' | 'needs-review';

export type GateDecisionValue = 'allow' | 'reject' | 'needs-review';

export type CorrectionActionType =
  | 'retry'
  | 'rollback-parameters'
  | 'disable-variant'
  | 'request-structure-review'
  | 'reduce-budget'
  | 'freeze-promotion'
  | 'stop-plan';

export interface MetricTarget {
  metricId: string;
  direction: MetricDirection;
  minDelta?: number;
  maxRegression?: number;
  targetValue?: number;
}

export interface EvolutionConstraint {
  id: string;
  description: string;
  severity: RiskLevel;
}

export interface GoalSpec {
  id: string;
  name: string;
  objective: string;
  priority: number;
  targetMetrics: MetricTarget[];
  constraints: EvolutionConstraint[];
  stopConditions: string[];
}

export interface EnvironmentSignal {
  id: string;
  kind: 'performance' | 'error' | 'dependency' | 'data' | 'resource' | 'safety';
  description: string;
  severity: RiskLevel;
  observedAt: string;
}

export interface MetricReading {
  metricId: string;
  value: number;
  capturedAt: string;
}

export interface ErrorEvent {
  id: string;
  type:
    | 'temporary-failure'
    | 'parameter-degradation'
    | 'algorithm-regression'
    | 'structure-risk'
    | 'resource-exhaustion'
    | 'evaluation-distortion'
    | 'safety-boundary-triggered';
  message: string;
  occurredAt: string;
  variantId?: string;
}

export interface ResourceUsage {
  durationMs: number;
  computeUnits: number;
  apiCostUsd: number;
  storageBytes: number;
}

export interface EnvironmentSnapshot {
  id: string;
  capturedAt: string;
  signals: EnvironmentSignal[];
  performance: MetricReading[];
  errors: ErrorEvent[];
  resourceUsage: ResourceUsage;
}

export interface BaselineProfile {
  id: string;
  goalId: string;
  capturedAt: string;
  metrics: MetricReading[];
  resourceUsage: ResourceUsage;
}

export interface EvolutionTarget {
  id: string;
  kind: 'parameter-set' | 'algorithm-policy' | 'module-structure';
  description: string;
}

export interface ResourceBudget {
  maxDurationMs: number;
  maxComputeUnits: number;
  maxApiCostUsd: number;
  maxStorageBytes: number;
  maxConcurrency: number;
  maxHighRiskVariants: number;
}

export interface EvolutionPlan {
  id: string;
  goalId: string;
  hypothesis: string;
  targetObject: EvolutionTarget;
  allowedMutationTypes: MutationType[];
  evaluationProtocolId: string;
  resourceBudget: ResourceBudget;
}

export interface ParameterPatchOperation {
  op: 'setParameter';
  path: string;
  previousValue: unknown;
  nextValue: unknown;
}

export interface AlgorithmPatchOperation {
  op: 'selectAlgorithm';
  policyId: string;
  previousAlgorithm: string;
  nextAlgorithm: string;
}

export interface StructurePatchOperation {
  op: 'proposeStructureChange';
  planPath: string;
  summary: string;
}

export type VariantPatchOperation =
  | ParameterPatchOperation
  | AlgorithmPatchOperation
  | StructurePatchOperation;

export interface VariantPatch {
  operations: VariantPatchOperation[];
}

export interface MetricExpectation {
  metricId: string;
  expectedDelta: number;
  direction: MetricDirection;
}

export interface RollbackPlan {
  strategy: 'restore-previous-parameters' | 'disable-candidate' | 'manual-review-required';
  operations: VariantPatchOperation[];
}

export interface VariantProvenance {
  source: string;
  reference: string;
  capturedAt: string;
}

export interface VariantSpec {
  id: string;
  planId: string;
  mutationType: MutationType;
  description: string;
  patch: VariantPatch;
  expectedGain: MetricExpectation[];
  riskLevel: RiskLevel;
  rollbackPlan: RollbackPlan;
  provenance: VariantProvenance[];
}

export interface TrialResult {
  id: string;
  variantId: string;
  protocolId: string;
  metrics: MetricReading[];
  resourceUsage: ResourceUsage;
  errors: ErrorEvent[];
  completedAt: string;
}

export interface MetricDelta {
  metricId: string;
  baselineValue: number;
  candidateValue: number;
  delta: number;
  direction: MetricDirection;
  passed: boolean;
}

export interface RegressionFinding {
  metricId: string;
  baselineValue: number;
  candidateValue: number;
  regressionAmount: number;
  limit: number;
}

export interface SafetyFinding {
  id: string;
  severity: RiskLevel;
  message: string;
}

export interface EvaluationReport {
  id: string;
  variantId: string;
  baselineId: string;
  metricDeltas: MetricDelta[];
  regressions: RegressionFinding[];
  resourceCost: ResourceUsage;
  safetyFindings: SafetyFinding[];
  verdict: EvaluationVerdict;
}

export interface GateDecision {
  id: string;
  variantId: string;
  reportId: string;
  decision: GateDecisionValue;
  reasons: string[];
  decidedAt: string;
}

export interface PromotionRecord {
  id: string;
  variantId: string;
  gateDecisionId: string;
  appliedAt: string;
  rollbackPlan: RollbackPlan;
  previousState: Record<string, unknown>;
  nextState: Record<string, unknown>;
}

export interface CorrectionAction {
  id: string;
  errorEventId: string;
  type: CorrectionActionType;
  reason: string;
  createdAt: string;
  variantId?: string;
}

export interface EvolutionMemoryRecord {
  id: string;
  goalId?: string;
  variantId?: string;
  kind: 'variant' | 'trial' | 'evaluation' | 'gate' | 'promotion' | 'correction';
  summary: string;
  createdAt: string;
  payload: unknown;
}
