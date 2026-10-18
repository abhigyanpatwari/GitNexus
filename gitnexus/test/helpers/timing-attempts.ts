/**
 * Wall-clock guards without the flake. A regression these tests catch (a quadratic scan, a
 * backtracking regex) costs many times the bound on every run, so a single slow run on a loaded
 * or shared machine is noise, not a regression. Each attempt builds its own state, so a cache
 * warmed by an earlier attempt cannot hide the cost of the first one; the guard passes as soon as
 * one attempt is within the bound and fails with the fastest time seen when none is.
 */
export interface TimedAttempt<T> {
  readonly ms: number;
  readonly value: T;
}

/** Time `work` alone: `prepare` builds the state (untimed) and returns the work to time. */
export function timeWork<T>(prepare: () => () => T): TimedAttempt<T> {
  const work = prepare();
  const start = performance.now();
  const value = work();
  return { ms: performance.now() - start, value };
}

/**
 * Run `attempt` up to `tries` times, stopping at the first one within `budgetMs`. Returns the
 * fastest attempt (the passing one, else the least slow), whose `ms` the caller asserts on.
 */
export function fastestWithin<T>(
  budgetMs: number,
  attempt: () => TimedAttempt<T>,
  tries = 3,
): TimedAttempt<T> {
  let best: TimedAttempt<T> | undefined;
  for (let i = 0; i < tries; i++) {
    const current = attempt();
    if (best === undefined || current.ms < best.ms) best = current;
    if (current.ms <= budgetMs) break;
  }
  return best!;
}
