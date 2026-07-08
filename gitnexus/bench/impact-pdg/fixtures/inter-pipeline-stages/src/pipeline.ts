// A pipeline driver whose impact is cross-function: `runPipeline` calls each
// stage in turn. The stages themselves carry the work; the driver loops over
// them. Annotated UPSTREAM from the driver: "what does runPipeline depend on?"
// -> the stage functions it invokes. Intra-PDG is ~empty by design.

export function stageParse(n: number): number {
  return n + 1;
}

export function stageTransform(n: number): number {
  return n * 3;
}

export function stageEmit(n: number): number {
  return n - 2;
}

export function runPipeline(seed: number, enabled: boolean): number {
  // criterion (upstream): a driver. It depends on the three stage functions.
  let acc = seed;
  if (!enabled) {
    return acc; // a guard so the driver itself carries a CDG edge
  }
  acc = stageParse(acc);
  acc = stageTransform(acc);
  acc = stageEmit(acc);
  return acc;
}
