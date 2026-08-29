export type ImpactRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export type ImpactRiskAxis = 'processes' | 'modules';

export type UnusedImpactRiskReason =
  | 'file-nodes-have-no-process-or-community-membership'
  | 'enrichment-skipped'
  | 'enrichment-budget-exhausted'
  | 'enrichment-query-failed';

export interface UnusedImpactRiskAxis {
  axis: ImpactRiskAxis;
  reason: UnusedImpactRiskReason;
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

function countsWithUnusedAxesZeroed(
  input: ImpactRiskInput,
): Pick<
  ImpactRiskInput,
  'direction' | 'directCount' | 'processCount' | 'moduleCount' | 'impactedCount'
> {
  let processCount = input.processCount;
  let moduleCount = input.moduleCount;
  for (const unused of input.unusedAxes ?? []) {
    if (unused.axis === 'processes') processCount = 0;
    if (unused.axis === 'modules') moduleCount = 0;
  }
  return {
    direction: input.direction,
    directCount: input.directCount,
    processCount,
    moduleCount,
    impactedCount: input.impactedCount,
  };
}

/** Map walk outcomes to unused process/module axes so comparability matches what was sampled. */
export function unusedAxesForImpactWalk(input: {
  isFileTarget: boolean;
  skipEnrichment: boolean;
  maxChunks: number;
  processQueryFailed: boolean;
  moduleQueryFailed: boolean;
  /** When 0, a zero chunk budget is not an unused-axis event — there was nothing to enrich. */
  impactedCount?: number;
}): UnusedImpactRiskAxis[] {
  if (input.isFileTarget) {
    return [
      {
        axis: 'processes',
        reason: 'file-nodes-have-no-process-or-community-membership',
      },
      {
        axis: 'modules',
        reason: 'file-nodes-have-no-process-or-community-membership',
      },
    ];
  }
  if (input.skipEnrichment) {
    return [
      { axis: 'processes', reason: 'enrichment-skipped' },
      { axis: 'modules', reason: 'enrichment-skipped' },
    ];
  }
  if (input.maxChunks === 0 && (input.impactedCount ?? 1) > 0) {
    return [
      { axis: 'processes', reason: 'enrichment-budget-exhausted' },
      { axis: 'modules', reason: 'enrichment-budget-exhausted' },
    ];
  }
  const unused: UnusedImpactRiskAxis[] = [];
  if (input.processQueryFailed) {
    unused.push({ axis: 'processes', reason: 'enrichment-query-failed' });
  }
  if (input.moduleQueryFailed) {
    unused.push({ axis: 'modules', reason: 'enrichment-query-failed' });
  }
  return unused;
}

export function scoreImpactRisk(input: ImpactRiskInput): ImpactRiskResult {
  const unusedAxes = input.unusedAxes ?? [];

  return {
    risk: score(countsWithUnusedAxesZeroed(input)),
    riskSharedAxes: score({ ...input, processCount: 0, moduleCount: 0 }),
    riskScale: {
      comparableAcrossKinds: unusedAxes.length === 0,
      unusedAxes,
    },
  };
}
