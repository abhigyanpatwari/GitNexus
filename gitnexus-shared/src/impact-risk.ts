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

const UNMEASURED_REASONS: ReadonlySet<UnusedImpactRiskReason> = new Set([
  'file-nodes-have-no-process-or-community-membership',
  'enrichment-skipped',
  'enrichment-budget-exhausted',
]);

function unusedPair(reason: UnusedImpactRiskReason): UnusedImpactRiskAxis[] {
  return [
    { axis: 'processes', reason },
    { axis: 'modules', reason },
  ];
}

function countsWithUnmeasuredAxesZeroed(
  input: ImpactRiskInput,
): Pick<
  ImpactRiskInput,
  'direction' | 'directCount' | 'processCount' | 'moduleCount' | 'impactedCount'
> {
  let processCount = input.processCount;
  let moduleCount = input.moduleCount;
  for (const unused of input.unusedAxes ?? []) {
    if (!UNMEASURED_REASONS.has(unused.reason)) continue;
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
  impactedCount: number;
}): UnusedImpactRiskAxis[] {
  if (input.isFileTarget) {
    return unusedPair('file-nodes-have-no-process-or-community-membership');
  }
  if (input.skipEnrichment) {
    return unusedPair('enrichment-skipped');
  }
  if (input.maxChunks === 0 && input.impactedCount > 0) {
    return unusedPair('enrichment-budget-exhausted');
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
  const observedRisk = score(countsWithUnmeasuredAxesZeroed(input));
  const queryFailed = unusedAxes.some((unused) => unused.reason === 'enrichment-query-failed');
  // A failed query makes observed process/module counts lower bounds. Preserve
  // any HIGH/CRITICAL warning already proved by those counts, but never emit a
  // confident LOW/MEDIUM edit gate from an incomplete enrichment pass.
  const risk =
    queryFailed && (observedRisk === 'LOW' || observedRisk === 'MEDIUM') ? 'UNKNOWN' : observedRisk;

  return {
    risk,
    riskSharedAxes: score({ ...input, processCount: 0, moduleCount: 0 }),
    riskScale: {
      comparableAcrossKinds: unusedAxes.length === 0,
      unusedAxes,
    },
  };
}
