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
