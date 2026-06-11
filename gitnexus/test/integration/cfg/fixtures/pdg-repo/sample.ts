// Tiny repo fixture for the end-to-end --pdg pipeline test (#2081 M1).
// Two functions with branches/loops so the emitted CFG has multiple
// BasicBlock nodes and several CFG edge kinds.

export function classify(x: number): string {
  if (x > 0) {
    return 'pos';
  } else if (x < 0) {
    return 'neg';
  }
  return 'zero';
}

export function total(xs: number[]): number {
  let sum = 0;
  for (const x of xs) {
    if (x > 0) {
      sum += x;
    }
  }
  return sum;
}
