// The MIRROR of the Java/JS case. TypeScript sets
// `fieldFallbackOnMethodLookup: false`, so name inference does not run for it
// at all — correctly, since a type system should answer precisely. But that
// opt-out also skipped REPORTING, so this read answered the same silent empty
// as the case round 3 was filed about, in the other direction.
export function renderJsOnly(bag: { [k: string]: number }): number {
  return bag.jsOnlyThreshold;
}

// The case that makes `reportOnly` load-bearing: a TypeScript property and a
// TypeScript read of it through an untyped receiver. Name inference COULD link
// these — same language, unique name — which is precisely what
// `fieldFallbackOnMethodLookup: false` forbids. Running the pass for reporting
// must not quietly re-enable it.
// An INTERFACE member, not an object literal: the object-literal Property rule
// is JavaScript-only, so a `const X = { ... }` in a .ts file mints no node and
// there would be nothing for inference to link either way.
export interface TsBudget {
  tsOnlyBudget: number;
}

export function readsTsOnly(bag: { [k: string]: number }): number {
  return bag.tsOnlyBudget;
}
