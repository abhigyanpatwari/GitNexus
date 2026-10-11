/**
 * Shared cost guard for the R argument-selection queries (the scope query and
 * R_QUERIES). Both once had a quadratic formulation (an argument-prefix pattern
 * repeated before the naming argument) that took seconds on one call with thousands
 * of arguments.
 *
 * Absolute wall-clock limits are machine-dependent, so the guard compares the same
 * work at two input sizes: linear work grows ~4x when the argument count is
 * quadrupled, a quadratic query ~16x. Timings use the fastest of several runs and a
 * floor on the small run, so scheduler noise on a loaded runner cannot inflate the
 * ratio. Correctness of the output is asserted by the callers at both sizes, so an
 * early return or an empty parse cannot pass as "fast".
 */

export const SMALL_N = 2000;
export const LARGE_N = 8000;
/** Linear is ~4; quadratic is ~16 or worse. */
export const MAX_RATIO = 10;
/** The small run is never treated as faster than this (below it, noise dominates). */
const FLOOR_MS = 15;
const REPEATS = 3;

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
 * Runs the work produced by `prepare(source)` at SMALL_N and LARGE_N and returns the
 * results and the time ratio. `prepare` does the untimed set-up (e.g. parsing) and
 * returns the thunk that is timed.
 */
export function measureScaling<T>(
  prepare: (source: string) => () => T,
  build: (n: number) => string,
): { small: T; large: T; ratio: number } {
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
  const small = run(SMALL_N);
  const large = run(LARGE_N);
  return {
    small: small.result,
    large: large.result,
    ratio: large.ms / Math.max(small.ms, FLOOR_MS),
  };
}
