/**
 * Run finite conformance cases in order. Several cases share a native database,
 * mutate process-wide settings, or measure their own execution time.
 * @template T
 * @param {Iterable<T>} cases
 * @param {(value: T) => Promise<void>} run
 * @returns {Promise<void>}
 */
export function runInSequence(cases, run) {
  return Array.from(cases).reduce(
    (previous, value) => previous.then(() => run(value)),
    Promise.resolve(),
  );
}
