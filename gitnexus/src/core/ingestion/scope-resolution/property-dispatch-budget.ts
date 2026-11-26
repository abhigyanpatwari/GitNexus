/** Opt-in per-key candidate-pair budget (#3924); unset/invalid preserves the graph. */
export const MAX_PROPERTY_DISPATCH_EDGES_PER_KEY = (() => {
  const env = Number(process.env.GITNEXUS_MAX_PROPERTY_DISPATCH_EDGES_PER_KEY);
  return Number.isSafeInteger(env) && env >= 1 ? env : Infinity;
})();

/** JSON-safe effective budget; null and pre-budget metadata both mean unlimited. */
export const PROPERTY_DISPATCH_BUDGET_STAMP = Number.isFinite(MAX_PROPERTY_DISPATCH_EDGES_PER_KEY)
  ? MAX_PROPERTY_DISPATCH_EDGES_PER_KEY
  : null;

export const propertyDispatchBudgetMismatch = (recorded: unknown): boolean =>
  (recorded === undefined ? null : recorded) !== PROPERTY_DISPATCH_BUDGET_STAMP;
