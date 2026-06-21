// Mixed-locus fixture: `computeAndEmit` has a real intra-procedural data-flow
// computation (a running `score` accumulated in a loop, then thresholded) AND a
// cross-function reach (it calls `emit`). The criterion's blast radius spans
// both loci.

export function emit(level: string): string {
  return '[' + level + ']';
}

export function computeAndEmit(values: number[]): string {
  // criterion: mixed. Intra: score accumulation + threshold; inter: emit().
  let score = 0; // def; loop-carried accumulation below
  for (const v of values) {
    score = score + v; // data-dependent on prior `score`
  }
  const level = score > 10 ? 'high' : 'low'; // data-dependent on `score`
  return emit(level); // cross-function reach; arg data-dependent on `level`
}
