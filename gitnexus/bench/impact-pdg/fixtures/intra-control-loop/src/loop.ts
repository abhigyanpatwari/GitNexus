// Pure intra-procedural CONTROL-dependence fixture, annotated UPSTREAM.
// The criterion is the loop body; upstream asks "what controls whether this
// runs?" The answer is the enclosing loop guard. Exercises the CDG-reverse arm
// of KTD4 over a loop's control structure, all within one function.

export function filterPositive(xs: number[]): number {
  let count = 0;
  for (const x of xs) {
    // the loop guard controls the body below
    if (x > 0) {
      count = count + 1; // criterion (upstream): controlled by the loop AND the if
    }
  }
  return count;
}
