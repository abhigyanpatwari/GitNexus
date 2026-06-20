// Pure intra-procedural data-flow fixture: a straight-line def->use chain.
// Changing the first definition `a` flows through `b` and `c` to the return,
// all within one function. There are no branches and no calls — the purest
// REACHING_DEF chain.

export function chainCompute(input: number): number {
  const a = input + 1; // criterion: the def of `a`
  const b = a * 2; // data-dependent on `a`
  const c = b - 3; // data-dependent on `b` (transitively on `a`)
  return c; // data-dependent on `c`
}
