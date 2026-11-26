/** Opt-in per-key candidate-pair budget (#3924); unset/invalid preserves the graph. */
export const MAX_PROPERTY_DISPATCH_EDGES_PER_KEY = (() => {
  const env = Number(process.env.GITNEXUS_MAX_PROPERTY_DISPATCH_EDGES_PER_KEY);
  return Number.isSafeInteger(env) && env >= 1 ? env : Infinity;
})();
