/**
 * Shared cost guard for the R argument-selection queries (the scope query and
 * R_QUERIES). Both once had a quadratic formulation (an argument-prefix pattern
 * repeated before the naming argument) that took seconds on one call with thousands
 * of arguments.
 *
 * Absolute wall-clock limits are machine-dependent, so the guard compares the same
 * work at two input sizes: linear work grows ~4x when the argument count is
 * quadrupled, a quadratic query ~16x. Timings use the fastest of several runs, so
 * scheduler noise on a loaded runner cannot inflate the ratio. Correctness of the
 * output is asserted by the callers at both sizes, so an early return or an empty
 * parse cannot pass as "fast". A measurement whose ratio is over the limit is repeated (at most
 * ATTEMPTS times in all): a quadratic query is over it every time, a noisy runner is not.
 *
 * A ratio is only meaningful when the small run is long enough to measure. A shape
 * whose cost per argument is tiny (comments before the naming argument took about
 * 1 ms at 2,000) would hide a quadratic regression behind the floor, so the small
 * size doubles from SMALL_N until the small run lasts TARGET_MS. The sizes thus follow
 * the machine: a slow or loaded one reaches the target at a smaller size, a fast one
 * at a larger size, and the large run is always four times the small one.
 */

export const SMALL_N = 2000;
export const LARGE_N = 8000;
/** Linear is ~4; quadratic is ~16 or worse. */
export const MAX_RATIO = 10;
/** The small size doubles until its fastest run lasts this long (below it, noise dominates). */
const TARGET_MS = 20;
/** Largest small size tried; the large run is four times it. */
const MAX_SMALL_N = 256_000;
/**
 * Divisor floor for a small run that stays short at MAX_SMALL_N, where the work per
 * argument is too small to measure and noise would inflate the ratio.
 */
const FLOOR_MS = 15;
const REPEATS = 3;
/** Whole measurements tried before a ratio over MAX_RATIO is reported. */
const ATTEMPTS = 3;

export interface ArgumentShape {
  readonly name: string;
  readonly build: (n: number) => string;
}

const named = (n: number) => Array.from({ length: n }, (_, k) => `a${k} = ${k}`).join(', ');
const comments = (n: number) => Array.from({ length: n }, (_, k) => `# c${k}`).join('\n');
const unnamedStrings = (n: number) => Array.from({ length: n }, (_, k) => `"s${k}"`).join(', ');
const namedStrings = (n: number) =>
  Array.from({ length: n }, (_, k) => `a${k} = "s${k}"`).join(', ');

export const SHAPES = {
  listNamedArguments: {
    name: 'one call with many named arguments',
    build: (n) => `x <- list(${named(n)})`,
  },
  setClassNamedBefore: {
    name: 'setClass with many named arguments before the name',
    build: (n) => `setClass(${named(n)}, "A")`,
  },
  libraryNamedBefore: {
    name: 'library with many named arguments before the name',
    build: (n) => `library(${named(n)}, pkg)`,
  },
  setClassCommentsBefore: {
    name: 'setClass with many comments before the name',
    build: (n) => `setClass(\n${comments(n)}\n"A")`,
  },
  libraryCommentsBefore: {
    name: 'library with many comments before the name',
    build: (n) => `library(\n${comments(n)}\npkg)`,
  },
  setClassUnnamedStrings: {
    name: 'setClass with many unnamed arguments',
    build: (n) => `setClass(${unnamedStrings(n)})`,
  },
  libraryUnnamedStrings: {
    name: 'library with many unnamed arguments',
    build: (n) => `library(${unnamedStrings(n)})`,
  },
  setClassNamedStrings: {
    name: 'setClass with many named string arguments',
    build: (n) => `setClass("A", ${namedStrings(n)})`,
  },
} as const satisfies Record<string, ArgumentShape>;

/**
 * Runs the work produced by `prepare(source)` at a small size (SMALL_N, doubled until the
 * run lasts TARGET_MS) and at four times that size, and returns the results, the time
 * ratio and the sizes used. `prepare` does the untimed set-up (e.g. parsing) and returns
 * the thunk that is timed.
 */
export function measureScaling<T>(
  prepare: (source: string) => () => T,
  build: (n: number) => string,
): { small: T; large: T; ratio: number; smallN: number; largeN: number } {
  // A quadratic query is ~16x on every attempt, a linear one ~4x: a ratio over the limit that
  // the next attempt does not reproduce was scheduler noise (a pause during the small run
  // shrinks nothing, but one during the large run inflates it). Stop at the first attempt within
  // the limit; otherwise report the lowest ratio seen.
  let best: ReturnType<typeof measureScalingOnce<T>> | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const current = measureScalingOnce(prepare, build);
    if (best === undefined || current.ratio < best.ratio) best = current;
    if (current.ratio <= MAX_RATIO) break;
  }
  return best!;
}

function measureScalingOnce<T>(
  prepare: (source: string) => () => T,
  build: (n: number) => string,
): { small: T; large: T; ratio: number; smallN: number; largeN: number } {
  const run = (n: number) => {
    const thunk = prepare(build(n));
    let best = Infinity;
    let result!: T;
    for (let i = 0; i < REPEATS; i++) {
      const start = performance.now();
      result = thunk();
      best = Math.min(best, performance.now() - start);
    }
    return { result, ms: best };
  };
  let smallN = SMALL_N;
  let small = run(smallN);
  while (small.ms < TARGET_MS && smallN < MAX_SMALL_N) {
    smallN *= 2;
    small = run(smallN);
  }
  const largeN = smallN * (LARGE_N / SMALL_N);
  const large = run(largeN);
  return {
    small: small.result,
    large: large.result,
    ratio: large.ms / Math.max(small.ms, FLOOR_MS),
    smallN,
    largeN,
  };
}
