// Pure intra-procedural CONTROL-dependence fixture: an if/else-if/else.
// The branch predicate controls which return statement runs. Changing the
// branch (the criterion) control-affects all three arms via CDG, all within
// the same function.

export function classify(x: number): string {
  if (x > 0) {
    // criterion: the branch predicate controls the arms below
    return 'pos'; // control-dependent on the branch (first arm)
  } else if (x < 0) {
    return 'neg'; // control-dependent on the branch (second arm)
  }
  return 'zero'; // control-dependent on the branch (fallthrough arm)
}
