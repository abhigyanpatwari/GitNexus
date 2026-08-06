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
