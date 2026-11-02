// Scenario-map controls fixture (Phase 1 U17), pair `unicode-normalize`. The composition happens
// inside String.prototype.normalize, called on the input itself (receiver position). The form is
// left at its NFC default: a mutated (empty) form string would make the call throw.

/** Length in UTF-16 code units of a name after canonical composition (NFC); empty names are 0. */
export function composedLength(name: string): number {
  if (name === '') {
    return 0;
  }
  return name.normalize().length;
}
