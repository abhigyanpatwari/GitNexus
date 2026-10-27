// Scenario-map controls fixture (Phase 1 U17), pair `set-non-member`. A supported Set table read
// through `has`: a table read, not an opaque call, although Set is declared in lib.*.d.ts (design
// §5.3a step 3), and not wrapped by the trace.

const RESERVED_WORDS: ReadonlySet<string> = new Set(['class', 'enum', 'super']);

/** True when a word is reserved and cannot name a symbol. */
export function isReservedWord(word: string): boolean {
  return RESERVED_WORDS.has(word);
}
