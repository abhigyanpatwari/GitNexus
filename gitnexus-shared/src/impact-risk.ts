export type ImpactRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export type ImpactRiskAxis = 'processes' | 'modules';

export interface UnusedImpactRiskAxis {
  axis: ImpactRiskAxis;
  reason: 'file-nodes-have-no-process-or-community-membership' | 'enrichment-skipped';
}

export interface ImpactRiskInput {
  direction: 'upstream' | 'downstream';
  directCount: number;
  processCount: number;
  moduleCount: number;
  impactedCount: number;
  unusedAxes?: readonly UnusedImpactRiskAxis[];
}

export interface ImpactRiskResult {
  risk: ImpactRisk;
  riskSharedAxes: ImpactRisk;
  riskScale: {
    comparableAcrossKinds: boolean;
    unusedAxes: readonly UnusedImpactRiskAxis[];
  };
}

function score(
  input: Pick<
    ImpactRiskInput,
    'direction' | 'directCount' | 'processCount' | 'moduleCount' | 'impactedCount'
  >,
): ImpactRisk {
  const { direction, directCount, processCount, moduleCount, impactedCount } = input;

  if (direction === 'upstream' && impactedCount === 0) return 'UNKNOWN';
  if (directCount >= 30 || processCount >= 5 || moduleCount >= 5 || impactedCount >= 200) {
    return 'CRITICAL';
  }
  if (directCount >= 15 || processCount >= 3 || moduleCount >= 3 || impactedCount >= 100) {
    return 'HIGH';
  }
  if (directCount >= 5 || impactedCount >= 30) return 'MEDIUM';
  return 'LOW';
}

export function scoreImpactRisk(input: ImpactRiskInput): ImpactRiskResult {
  const unusedAxes = input.unusedAxes ?? [];

  return {
    risk: score(input),
    riskSharedAxes: score({ ...input, processCount: 0, moduleCount: 0 }),
    riskScale: {
      comparableAcrossKinds: unusedAxes.length === 0,
      unusedAxes,
    },
  };
}
