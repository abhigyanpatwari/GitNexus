// Pure intra-procedural CONTROL-dependence fixture: the guard clause.
// The early-return guard predicate controls whether the post-guard body runs.
// Changing the guard (the criterion) control-affects the body statements via
// CDG controller->dependent edges, all within the same function.

export function guarded(ok: boolean, x: number): number {
  if (!ok) {
    // criterion: the guard predicate controls the arms below
    return -1; // control-dependent on the guard (true arm)
  }
  const y = x * 2; // control-dependent on the guard (false arm reaches here)
  const z = y + 1; // control-dependent on the guard, data-dependent on `y`
  return z; // control-dependent on the guard
}
