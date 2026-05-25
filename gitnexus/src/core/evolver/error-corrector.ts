import type { CorrectionAction, CorrectionActionType, ErrorEvent } from './types.js';

const createdAt = '2026-05-25T00:00:00.000Z';

const ERROR_ACTION_MAP: Record<ErrorEvent['type'], CorrectionActionType> = {
  'temporary-failure': 'retry',
  'parameter-degradation': 'rollback-parameters',
  'algorithm-regression': 'disable-variant',
  'structure-risk': 'request-structure-review',
  'resource-exhaustion': 'reduce-budget',
  'evaluation-distortion': 'freeze-promotion',
  'safety-boundary-triggered': 'stop-plan',
};

const ERROR_REASON_MAP: Record<ErrorEvent['type'], string> = {
  'temporary-failure': 'temporary failure may succeed on retry',
  'parameter-degradation': 'parameter change caused degradation, rollback required',
  'algorithm-regression': 'algorithm change caused regression, variant must be disabled',
  'structure-risk': 'structure change poses risk, manual review required',
  'resource-exhaustion': 'resource limits exceeded, budget must be reduced',
  'evaluation-distortion': 'evaluation results are unreliable, promotion must be frozen',
  'safety-boundary-triggered': 'safety boundary violated, plan must be stopped',
};

export function selectCorrectionAction(errorEvent: ErrorEvent): CorrectionAction {
  return {
    id: `correction-${errorEvent.id}`,
    errorEventId: errorEvent.id,
    type: ERROR_ACTION_MAP[errorEvent.type],
    reason: ERROR_REASON_MAP[errorEvent.type],
    createdAt,
    variantId: errorEvent.variantId,
  };
}
