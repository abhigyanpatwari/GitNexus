// Guard-clause + data-flow fixture for the pdg_query integration test (#2086).
// Kept free of taint sources/sinks so it adds no TAINTED findings to the shared
// pdg-repo fixture (taint-explain / pipeline-pdg assert on taint dynamically).

export function guarded(ok: boolean, x: number): number {
  // `if (!ok) return` — the early return is control-dependent on the guard
  // predicate (the #559 guard-clause shape); the post-guard body is
  // control-dependent on the complementary arm.
  if (!ok) {
    return -1;
  }
  const y = x * 2;
  const z = y + 1;
  return z;
}

export function loopFlow(items: number[]): number {
  // A loop-carried accumulator — exercises REACHING_DEF (def→use of `sum`).
  let sum = 0;
  for (const it of items) {
    sum = sum + it;
  }
  return sum;
}
