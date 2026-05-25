import type {
  ErrorEvent,
  MetricReading,
  ResourceBudget,
  ResourceUsage,
  TrialResult,
  VariantSpec,
} from './types.js';

export interface SandboxProtocol {
  id: string;
  maxDurationMs: number;
}

export interface SandboxRunnerResult {
  metrics: MetricReading[];
  resourceUsage: ResourceUsage;
}

export type SandboxRunner = (variant: VariantSpec, protocol: SandboxProtocol) => Promise<SandboxRunnerResult>;

const completedAt = '2026-05-25T00:00:00.000Z';

export async function runSandboxTrial(
  variant: VariantSpec,
  protocol: SandboxProtocol,
  runner: SandboxRunner,
  budget: ResourceBudget,
): Promise<TrialResult> {
  const trialId = buildTrialId(variant, protocol);

  if (protocol.maxDurationMs > budget.maxDurationMs) {
    return buildFailedTrial(
      trialId,
      variant,
      protocol,
      'resource-exhaustion',
      'sandbox protocol duration budget exceeded',
    );
  }

  try {
    const result = await runner(variant, protocol);

    return {
      id: trialId,
      variantId: variant.id,
      protocolId: protocol.id,
      metrics: result.metrics,
      resourceUsage: result.resourceUsage,
      errors: [],
      completedAt,
    };
  } catch (error) {
    return buildFailedTrial(
      trialId,
      variant,
      protocol,
      'temporary-failure',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function buildFailedTrial(
  trialId: string,
  variant: VariantSpec,
  protocol: SandboxProtocol,
  type: ErrorEvent['type'],
  message: string,
): TrialResult {
  return {
    id: trialId,
    variantId: variant.id,
    protocolId: protocol.id,
    metrics: [],
    resourceUsage: emptyResourceUsage(),
    errors: [
      {
        id: `error-${trialId}`,
        type,
        message,
        occurredAt: completedAt,
        variantId: variant.id,
      },
    ],
    completedAt,
  };
}

function buildTrialId(variant: VariantSpec, protocol: SandboxProtocol): string {
  return `trial-${variant.id}-${protocol.id}`;
}

function emptyResourceUsage(): ResourceUsage {
  return {
    durationMs: 0,
    computeUnits: 0,
    apiCostUsd: 0,
    storageBytes: 0,
  };
}
