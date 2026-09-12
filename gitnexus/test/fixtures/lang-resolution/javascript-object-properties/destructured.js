// R2-1c: the function that IMPLEMENTS the behaviour reads its settings by
// destructuring them out of the argument. The field never appears in a
// member_expression, so before this it had no read site at all and the most
// relevant reader was missing from "who reads this setting?".
export const destructuredDefaults = {
  destructuredOnlyField: 7,
};

export function appliesDestructured({ destructuredOnlyField = 0 }) {
  return destructuredOnlyField * 2;
}

export function appliesRenamed({ destructuredOnlyField: aliased }) {
  return aliased;
}

export function appliesShorthand({ destructuredOnlyField }) {
  return destructuredOnlyField;
}

// R2-1b: record CONSTRUCTION. Both of these SET `destructuredOnlyField` —
// the nested-under-a-key form and the returned-literal form — and neither is
// bound to a variable, so neither mints a definition.
export function buildPlan(settings) {
  return {
    exitContract: {
      destructuredOnlyField: settings.raw ?? 0,
    },
  };
}

export function buildFlat(settings) {
  return {
    destructuredOnlyField: settings.raw ?? 1,
  };
}

// NEGATIVE CONTROL: an inline call-argument prop bag is call-site data, not a
// record with a name attached, and must stay excluded exactly as it is for
// definitions.
function consume(bag) {
  return bag;
}
export const consumed = consume({ notAConstructedField: 3 });
