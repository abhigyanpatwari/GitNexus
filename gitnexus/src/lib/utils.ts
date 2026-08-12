export const generateId = (label: string, name: string): string => {
  return `${label}:${name}`;
};

/**
 * Total order on strings by UTF-16 code unit — deliberately NOT `localeCompare`.
 *
 * `localeCompare` resolves against the host's default ICU locale, so two machines
 * can order the same pair differently and a tie-broken cap keeps a different
 * subset on each (#2787). Code-unit order is host-independent and matches the
 * binary `ORDER BY` the graph queries use, so a JS re-sort reproduces the DB's
 * order instead of fighting it.
 *
 * Use this for every tiebreak that feeds a `.slice()`, a page boundary, or any
 * other cut — `Array.prototype.sort` is stable, so a comparator that returns 0
 * for distinct elements silently falls back to input order.
 */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * How many links of an `Error.cause` chain any walker below visits, counting
 * the head. THE bound — hand-rolled copies had drifted to three different
 * numbers with three different loop conditions (`depth < 5` in two places,
 * `depth <= 5` in a third, i.e. six levels).
 *
 * The bound exists purely so a cyclic chain (`a.cause = b; b.cause = a`)
 * cannot loop forever. Real chains are one or two links deep — the ingestion
 * phase runner wraps a phase failure once as
 * `new Error("Phase 'X' failed: …", { cause })` — so five leaves ample
 * headroom for future nesting.
 */
export const CAUSE_CHAIN_MAX_DEPTH = 5;

/**
 * Walk `err` and its `cause` chain, head first, yielding each `Error` link.
 *
 * Stops at the first non-`Error` link (a `cause` may legally be any value, and
 * a non-Error carries no further `cause` worth following) and after
 * `maxDepth` links. Non-`Error` input yields nothing.
 *
 * THE single cause-chain traversal. Consume this (or {@link findInCauseChain})
 * rather than re-rolling the `for (let depth = 0; …; current = current.cause)`
 * loop: every hand-rolled copy has to re-decide the bound and the loop
 * condition, and they did not agree.
 */
export function* causeChain(err: unknown, maxDepth = CAUSE_CHAIN_MAX_DEPTH): Generator<Error> {
  let current: unknown = err;
  for (let depth = 0; depth < maxDepth && current instanceof Error; depth++) {
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * Find the first link of `err`'s cause chain that `match` accepts.
 *
 * Load-bearing for CLI error classification: the ingestion phase runner
 * rewraps every phase failure as `new Error("Phase 'X' failed: …", { cause })`,
 * so a bare `instanceof` at the CLI boundary misses the real error entirely
 * and falls through to a generic stack dump. Classify by TYPE through this
 * helper (the repo norm from #2385), never by message text.
 */
export function findInCauseChain<T>(
  err: unknown,
  match: (e: unknown) => e is T,
  maxDepth: number = CAUSE_CHAIN_MAX_DEPTH,
): T | undefined {
  for (const link of causeChain(err, maxDepth)) {
    if (match(link)) return link;
  }
  return undefined;
}

/**
 * Drop a Windows extended-length (`\\?\`) prefix from a path (#2667).
 *
 * **Comparison domain only.** Never apply this to a string that is about to be
 * handed to `fs`: libuv's `fs__capture_path` only converts WTF-8 to UTF-16 and
 * does *not* re-add the prefix for over-MAX_PATH paths, so stripping an
 * filesystem-facing path would break long-path access on hosts that have not
 * opted into `LongPathsEnabled`. Registry keys, repo-resolution lookups and
 * other pure string comparisons are safe — and are exactly where an
 * un-normalized prefix silently fails to match.
 *
 * The prefix can only ever arrive from caller-supplied input (`path.resolve`
 * preserves it); `realpathSync.native` cannot emit it, because libuv's
 * `fs__realpath_handle` strips it unconditionally.
 *
 * `\\?\Volume{GUID}\…` is deliberately left alone: the remainder of a volume-GUID
 * path is not a usable path, so stripping it would invent a wrong one. The `\\.\`
 * device namespace is left alone for the same reason and one more — most of what
 * it addresses (`\\.\PhysicalDrive0`, `\\.\COM1`, `\\.\pipe\…`) is not a
 * filesystem path at all. Both forms simply fail to match a registry entry, which
 * is the safe direction. `platform` is explicit so the transform is unit-testable
 * off Windows — same shape as `normalizeAnalyzerRootPath` in
 * `src/core/analyzer-identity.ts`.
 *
 * Call this on a `path.resolve`d path. Only the backslash spelling is matched,
 * which is sufficient there because `path.win32.resolve` already folds the
 * forward-slash spelling into it (`//?/D:/a` → `\\?\D:\a`). A raw, unresolved
 * `//?/…` string is returned unchanged rather than half-normalized.
 */
export const stripWindowsLongPathPrefix = (
  p: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform !== 'win32') return p;
  // Both spellings are case-insensitive: the Windows object namespace that
  // `\\?\` addresses is, so `\\?\unc\…` is as valid as `\\?\UNC\…`.
  //
  // Each pattern requires the component that makes the remainder a usable path —
  // a share name after `UNC\`, a separator after the drive colon. Without those
  // the slice would emit something worse than the input it was handed: `\\?\UNC`
  // would become the bare root `\\`, and the drive-relative `\\?\D:foo` would
  // become `D:foo`, which is not absolute and would resolve against the process
  // cwd if a future caller ever passed it to `fs`. A malformed extended path is
  // left untouched instead, so it simply fails to match a registry entry.
  if (/^\\\\\?\\UNC\\(?=[^\\])/i.test(p)) return `\\\\${p.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(p)) return p.slice(4);
  return p;
};

/**
 * Split `items` into consecutive slices of at most `size`.
 *
 * Returns an empty array for empty input, and never returns an empty slice, so
 * `for (const batch of chunk(xs, n))` always has something to work on.
 *
 * Callers batching a GRAPH QUERY should take the size from
 * `LBUG_QUERY_BATCH_SIZE` (`core/lbug/query-batch.ts`), which documents why a
 * query built from a caller-sized array needs a ceiling at all (#2915).
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  // `NaN` fails every comparison, so a bare `size < 1` lets it through and
  // `i += NaN` produces exactly one empty slice — the shape the docstring above
  // promises never to return. `mapConcurrent`'s `Math.max(1, …)` propagates a
  // NaN concurrency the same way, so the guard has to cover non-finite sizes
  // rather than just small ones.
  if (!Number.isFinite(size) || size < 1) {
    throw new RangeError(`chunk size must be >= 1, got ${size}`);
  }
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Run `run` over each item with at most `concurrency` in flight, returning the
 * results in input order.
 *
 * A failure is reported through `onError` and yields `undefined` for that item,
 * so one bad item degrades the result (the caller raises its own `partial`
 * flag) instead of discarding the items that succeeded beside it.
 *
 * This SCHEDULES, it does not synchronize: `run` must be safe to execute
 * concurrently with itself. Both kinds of caller here are — `fs.readFile` per
 * path in the ingestion walkers, and graph queries, where `executeParameterized`
 * checks a connection out of the per-repo pool for the duration of the query
 * (`pool-adapter.ts`) so parallel calls never share one. The default leaves
 * headroom for other in-flight work.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  options: { concurrency?: number; onError?: (error: unknown) => void } = {},
): Promise<(R | undefined)[]> {
  const settle = async (item: T): Promise<R | undefined> => {
    try {
      return await run(item);
    } catch (error) {
      options.onError?.(error);
      return undefined;
    }
  };

  // Wave scheduling rather than a rolling window: measured on the real query
  // path the two are within noise (538ms vs 532ms on a 1,000-file diff, whose
  // per-batch times spread only 1.35x), and most inputs produce a single wave.
  const results: (R | undefined)[] = [];
  for (const wave of chunk(items, Math.max(1, options.concurrency ?? 4))) {
    results.push(...(await Promise.all(wave.map(settle))));
  }
  return results;
}
