// Pure intra-procedural data-flow fixture.
// `sum` is a loop-carried accumulator: its definition flows forward to the
// next iteration's use and to the final `return`. Changing the `sum` def
// (the criterion) affects only statements within this same function via
// REACHING_DEF def->use edges. Nothing crosses a function boundary.

export function total(xs: number[]): number {
  let sum = 0; // criterion: the def of `sum`
  for (const x of xs) {
    sum = sum + x; // use of `sum` (and a redefinition) — data-dependent on the def
  }
  return sum; // use of `sum` — data-dependent
}
