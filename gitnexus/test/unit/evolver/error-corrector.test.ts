import { describe, expect, it } from 'vitest';
import { selectCorrectionAction } from '../../../src/core/evolver/index.js';
import type { ErrorEvent } from '../../../src/core/evolver/index.js';

const occurredAt = '2026-05-25T00:00:00.000Z';

function errorEvent(type: ErrorEvent['type'], variantId = 'variant-1'): ErrorEvent {
  return {
    id: `error-${type}`,
    type,
    message: `${type} occurred`,
    occurredAt,
    variantId,
  };
}

describe('selectCorrectionAction', () => {
  it('maps temporary-failure to retry', () => {
    const action = selectCorrectionAction(errorEvent('temporary-failure'));
    expect(action).toEqual({
      id: `correction-error-temporary-failure`,
      errorEventId: 'error-temporary-failure',
      type: 'retry',
      reason: 'temporary failure may succeed on retry',
      createdAt: occurredAt,
      variantId: 'variant-1',
    });
  });

  it('maps parameter-degradation to rollback-parameters', () => {
    const action = selectCorrectionAction(errorEvent('parameter-degradation'));
    expect(action.type).toBe('rollback-parameters');
    expect(action.errorEventId).toBe('error-parameter-degradation');
    expect(action.variantId).toBe('variant-1');
  });

  it('maps algorithm-regression to disable-variant', () => {
    const action = selectCorrectionAction(errorEvent('algorithm-regression'));
    expect(action.type).toBe('disable-variant');
    expect(action.errorEventId).toBe('error-algorithm-regression');
  });

  it('maps structure-risk to request-structure-review', () => {
    const action = selectCorrectionAction(errorEvent('structure-risk'));
    expect(action.type).toBe('request-structure-review');
    expect(action.errorEventId).toBe('error-structure-risk');
  });

  it('maps resource-exhaustion to reduce-budget', () => {
    const action = selectCorrectionAction(errorEvent('resource-exhaustion'));
    expect(action.type).toBe('reduce-budget');
    expect(action.errorEventId).toBe('error-resource-exhaustion');
  });

  it('maps evaluation-distortion to freeze-promotion', () => {
    const action = selectCorrectionAction(errorEvent('evaluation-distortion'));
    expect(action.type).toBe('freeze-promotion');
    expect(action.errorEventId).toBe('error-evaluation-distortion');
  });

  it('maps safety-boundary-triggered to stop-plan', () => {
    const action = selectCorrectionAction(errorEvent('safety-boundary-triggered'));
    expect(action.type).toBe('stop-plan');
    expect(action.errorEventId).toBe('error-safety-boundary-triggered');
  });
});
