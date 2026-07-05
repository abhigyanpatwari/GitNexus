// Shared TypeScript module imported by app.vue. Because app.vue's
// `collectScopeContextPaths` does a transitive import closure, THIS file is
// pulled into the Vue scope-resolution pass IN ADDITION to the primary
// TypeScript pass — so its worker-built CFG (the functions below) is
// PDG-emitted in BOTH passes over the same `cfgSideChannel`, producing
// identical BasicBlock + PDG-edge ids. The in-memory graph dedups those by id
// (first-writer-wins Map); the streaming sink relies on per-file dedup in
// run.ts (`pdgEmittedFiles`). This is the real cross-pass double-emit the
// #2202 streaming dedup must collapse (review #8a).

export function classify(x: number): string {
  let label: string;
  if (x > 0) {
    label = 'positive';
  } else if (x < 0) {
    label = 'negative';
  } else {
    label = 'zero';
  }
  return label;
}

export function accumulate(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      sum += i;
    } else {
      sum -= 1;
    }
  }
  return sum;
}

export function guard(value: number): number {
  if (value > 100) {
    return clamp(value);
  }
  return value;
}

function clamp(value: number): number {
  return value > 100 ? 100 : value;
}
