// A JS read of the same name through an untyped receiver. Workspace-wide the
// name is unique, so unique-name inference resolved it — to a Java private
// field, across a language boundary with no call path.
export function renderLoyalty(cfg) {
  return cfg.loyaltyPointsBalance;
}

// CONTROL: a same-language target the pass SHOULD still reach, so the fix is
// shown to restrict by language rather than to disable the pass.
export const jsConfig = {
  jsOnlyThreshold: 10,
};

export function readsJsOnly(bag) {
  return bag.jsOnlyThreshold;
}

// BOUND-RECEIVER ARM (review finding 2). The reads above have UNTYPED receivers,
// so they route through unique-name inference — the pass this fixture was
// written to police. One extra token gives the receiver a type and routes an
// identical read through `return-shape-members.ts` instead: a sibling pass that
// consumed the same whole-graph index with no language restriction, and emitted
// at the 0.9 PRECISE tier where a `minConfidence` floor cannot filter it out.
//
// `Loyalty` is declared ONLY in Java. Construction types the receiver through
// the shared (polyglot) class registry, so the producer resolves into
// `Loyalty.java` and its member genuinely lives in that same file — which is
// why a same-FILE check alone waves this through and only a same-LANGUAGE check
// stops it. Nothing here may resolve.
export function readsBoundLoyalty() {
  const bound = new Loyalty();
  return bound.loyaltyPointsBalance;
}
