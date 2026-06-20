// Resolved-symbol-id SOUNDNESS fixture (U9 — plan 2026-06-18-001).
//
// Two callees share the LEAF name `process` but resolve to DISTINCT symbol ids
// (`Alpha.process` vs `Beta.process`). `route` invokes BOTH — so the symbol-graph
// BFS reaches both as direct callees — but each call lives in its OWN control
// block (separate `if` arms), so the SEED line's dependence slice contains only
// the block that calls `alpha.process`. The id bridge proves exactly
// `Alpha.process` for that seed line; the leaf-NAME bridge would prove BOTH
// (`process` is in the slice block's `callees`), over-attributing `Beta.process`.
// This fixture gates that the resolved-id bridge eliminates the same-leaf-name
// collision false-positive.

export class Alpha {
  process(value: number): number {
    return value + 1;
  }
}

export class Beta {
  process(value: number): number {
    return value * 2;
  }
}

export function route(x: number, useAlpha: boolean): number {
  const alpha = new Alpha();
  const beta = new Beta();
  let out = 0;
  if (useAlpha) {
    // SEED line: this block calls ONLY alpha.process — its slice carries the
    // resolved id `Alpha.process`, NOT `Beta.process`.
    out = alpha.process(x);
  } else {
    // Independent block: beta.process is reached by the BFS (shared `process`
    // leaf name) but is NOT on the alpha-seed line's dependence slice.
    out = beta.process(x);
  }
  return out;
}
