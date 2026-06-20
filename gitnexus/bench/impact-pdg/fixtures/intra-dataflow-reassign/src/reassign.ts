// Pure intra-procedural data-flow fixture, annotated UPSTREAM.
// The criterion is the final `return total` (a use of `total`); upstream asks
// "what does this use depend on?" The answer is every reaching definition of
// `total` within the function. Exercises the reverse RD arm of KTD4.

export function reassignSum(a: number, b: number): number {
  let total = a; // first def of `total` — reaches the use below
  total = total + b; // second def of `total` (uses prior) — reaches the use below
  return total; // criterion: use of `total`
}
