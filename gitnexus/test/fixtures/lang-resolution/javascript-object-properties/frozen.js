// R2-1a: a named shape published behind an IDENTITY-PRESERVING wrapper.
//
// Freezing a config object is the idiomatic way to publish an immutable
// contract, so the fields most worth querying are exactly the ones the bare
// `value: (object)` rule cannot see — one call expression sits between the
// declarator and the literal.
export const INERT_EXIT_CONTRACT = Object.freeze({
  frozenExitModel: 'bracket',
  frozenMaxHoldMs: 0,
});

export const SEALED_LIMITS = Object.seal({
  sealedMaxNotional: 100,
});

export function readsFrozen() {
  return INERT_EXIT_CONTRACT.frozenMaxHoldMs;
}

// NEGATIVE CONTROL. `buildRules` returns a value of its OWN making, so the
// literal here is an argument, not the thing `derivedRules` is bound to.
// Attributing `notAMemberOfDerived` to `derivedRules` would be a fabrication,
// which is why the wrapper allowlist is three identity functions and not
// "any call expression".
function buildRules(seed) {
  return { ...seed, extra: true };
}

export const derivedRules = buildRules({ notAMemberOfDerived: 1 });

// SECOND NEGATIVE CONTROL, and the one that actually exercises the allowlist.
// The control above is rejected STRUCTURALLY (a bare identifier callee never
// matches `function: (member_expression ...)`), so it would pass even if the
// wrapper predicate were dropped entirely. `Object.entries` has the same shape
// as `Object.freeze` and differs ONLY by name — it transforms its argument
// into an array of pairs rather than returning it — so this is the case that
// fails the moment the name check stops being enforced.
export const entryPairs = Object.entries({ notAMemberOfEntries: 1 });
