import type { GateDecision, PromotionRecord, VariantSpec } from './types.js';

const appliedAt = '2026-05-25T00:00:00.000Z';

export function applyPromotion(
  target: Record<string, unknown>,
  variant: VariantSpec,
  gateDecision: GateDecision,
): PromotionRecord | null {
  if (gateDecision.decision !== 'allow') {
    return null;
  }

  const previousState = structuredClone(target);

  for (const operation of variant.patch.operations) {
    if (operation.op === 'setParameter') {
      const segments = operation.path.split('.');
      setNestedValue(target, segments, operation.nextValue);
    }
  }

  return {
    id: `promo-${variant.id}-${gateDecision.id}`,
    variantId: variant.id,
    gateDecisionId: gateDecision.id,
    appliedAt,
    rollbackPlan: variant.rollbackPlan,
    previousState,
    nextState: structuredClone(target),
  };
}

export function rollbackPromotion(
  target: Record<string, unknown>,
  record: PromotionRecord,
): void {
  const keys = Object.keys(target);
  for (const key of keys) {
    delete target[key];
  }
  Object.assign(target, record.previousState);
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  if (path.length === 1) {
    obj[path[0]] = value;
    return;
  }
  const [head, ...rest] = path;
  if (obj[head] === undefined || typeof obj[head] !== 'object' || obj[head] === null) {
    obj[head] = {};
  }
  setNestedValue(obj[head] as Record<string, unknown>, rest, value);
}
