// AC3 fixtures (#2081 M1): the classic CFG hazards — try/throw/finally
// post-domination and labeled break/continue across nested loops. The visitor
// must route both normal completion AND an exception through `finally`, and
// resolve labeled jumps against the labeled (outer) loop, not the nearest one.

export function tryThrowFinally(flag: boolean): void {
  try {
    work();
    if (flag) {
      throw new Error('boom');
    }
  } catch (e) {
    handle();
  } finally {
    cleanup();
  }
  afterTry();
}

export function labeledBreak(xs: number[], ys: number[]): void {
  outer: for (const x of xs) {
    for (const y of ys) {
      if (x === y) {
        break outer;
      }
      inner();
    }
    afterInner();
  }
  done();
}

export function labeledContinue(xs: number[], ys: number[]): void {
  outer: for (const x of xs) {
    for (const y of ys) {
      if (x === y) {
        continue outer;
      }
      body();
    }
  }
  done();
}

declare function work(): void;
declare function handle(): void;
declare function cleanup(): void;
declare function afterTry(): void;
declare function inner(): void;
declare function afterInner(): void;
declare function body(): void;
declare function done(): void;
