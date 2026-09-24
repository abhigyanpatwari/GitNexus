// R3-3: the single most common config idiom in TypeScript. Both the named
// object-literal rule and the identity-wrapper rule were JAVASCRIPT_QUERIES
// only, so none of these keys minted a node: `context()` answered "Symbol not
// found" and a precise read through the holding variable had nothing to
// resolve to.
export const tsRuntimeConfig = {
  tsConfigRetries: 3,
  tsConfigTimeoutMs: 500,
};

export const TS_FROZEN_LIMITS = Object.freeze({
  tsFrozenMaxNotional: 100,
});

// The PRECISE path — the one TypeScript is supposed to use. The receiver is
// the holding variable, so this needs no name inference.
export function readsTsConfig(): number {
  return tsRuntimeConfig.tsConfigRetries + TS_FROZEN_LIMITS.tsFrozenMaxNotional;
}

// NEGATIVE CONTROL, same allowlist bound as the JavaScript rule: a non-identity
// call returns a value of its own, so the literal's keys are arguments rather
// than members of the binding.
export const tsMapped = Object.entries({ tsNotAMember: 1 });
