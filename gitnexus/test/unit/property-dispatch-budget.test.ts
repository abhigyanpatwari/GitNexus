import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

it.each([
  [undefined, undefined, null, false],
  [undefined, null, null, false],
  [undefined, 5, null, true],
  ['5', undefined, 5, true],
  ['5', null, 5, true],
  ['5', 5, 5, false],
  ['6', 5, 6, true],
  ['4', 5, 4, true],
  ['05', 5, 5, false],
  ['', null, null, false],
  ['0', null, null, false],
  ['-1', null, null, false],
  ['1.5', null, null, false],
  ['invalid', null, null, false],
  ['Infinity', null, null, false],
  ['9007199254740992', null, null, false],
  ['invalid', 5, null, true],
  ['5', '5', 5, true],
  [undefined, {}, null, true],
] as const)(
  'checks the recorded budget against the effective setting (%s, %s)',
  async (env, recorded, stamp, mismatch) => {
    vi.resetModules();
    vi.stubEnv('GITNEXUS_MAX_PROPERTY_DISPATCH_EDGES_PER_KEY', env);
    const { PROPERTY_DISPATCH_BUDGET_STAMP, propertyDispatchBudgetMismatch } =
      await import('../../src/core/ingestion/scope-resolution/property-dispatch-budget.js');
    expect(PROPERTY_DISPATCH_BUDGET_STAMP).toBe(stamp);
    expect(propertyDispatchBudgetMismatch(recorded)).toBe(mismatch);
  },
);
