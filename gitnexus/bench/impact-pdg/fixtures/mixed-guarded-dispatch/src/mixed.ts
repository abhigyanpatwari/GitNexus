// Mixed-locus fixture: `route` has an intra-procedural guard chain that both
// computes a `key` (data flow) and control-gates which callee runs (control
// flow), AND reaches two callees cross-function. Both loci are non-trivial.

export function fast(n: number): number {
  return n;
}

export function slow(n: number): number {
  return n + n;
}

export function route(n: number, urgent: boolean): number {
  // criterion: mixed. Intra: key + guard; inter: fast()/slow().
  const key = n % 2; // def; used in the guard below
  if (urgent || key === 0) {
    // control + data dependent on `key`
    return fast(n); // control-dependent on the guard; cross-function reach
  }
  return slow(n); // control-dependent on the complementary arm; cross-function reach
}
