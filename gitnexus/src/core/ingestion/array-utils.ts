/**
 * Append all elements from `source` into `target` without using the spread
 * operator.  `target.push(...source)` converts every element into a function
 * argument which exceeds V8's call-stack limit when `source` has more than
 * ~65 000 entries (common in large monoliths with many symbols).
 */
export function safePushAll<T>(target: T[], source: readonly T[]): void {
  for (let i = 0; i < source.length; i++) {
    target.push(source[i]);
  }
}
