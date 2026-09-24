/**
 * Shared shape for the name→count maps this directory persists into `RepoMeta`
 * (`UnresolvedReceiverSummary`, `UndecidedSatisfactionSummary`).
 *
 * Both are samples of an analysis-time fact, both are capped, and both are read
 * back by `impact` to hedge an answer. The ranking and the lookup therefore
 * have to behave identically across them — two hand-copied comparators that
 * must stay in step is exactly the drift these summaries cannot tolerate, and a
 * lookup that is prototype-safe in one artifact and not the other is a
 * user-facing bug waiting on whichever map is read first.
 */
import { compareCodeUnits } from '../../../lib/utils.js';

/**
 * Rank a name→count map highest-first and cap it.
 *
 * `compareCodeUnits`, not `localeCompare` (#2787). The tiebreak feeds the
 * `.slice()` below, so locale-sensitive collation would decide WHICH entries
 * survive the cap, not merely how they are listed — and ICU order varies by
 * platform and ICU build, so two runs over one repo could persist different
 * sets. Key-based lookup is unaffected either way.
 *
 * `omitted` is the number of distinct names past the cap, so the caller can
 * report truncation rather than silently losing entries.
 */
export function rankAndCap(
  counts: ReadonlyMap<string, number>,
  cap: number,
): { kept: [string, number][]; omitted: number } {
  const ranked = [...counts.entries()].sort(
    ([aName, aCount], [bName, bCount]) => bCount - aCount || compareCodeUnits(aName, bName),
  );
  const kept = ranked.slice(0, cap);
  return { kept, omitted: ranked.length - kept.length };
}

/**
 * Read one count out of a persisted map, prototype-safely.
 *
 * The map is revived from JSON, so a bare `counts[name]` returns a Function for
 * `constructor` / `toString` / `valueOf` — all ordinary member and type names in
 * a code graph — and a Function compares as neither absent nor a number, which
 * is how one of these once interpolated a function into user-facing text.
 *
 * Returns `undefined` when the name was never recorded, and only ever a finite
 * positive number otherwise.
 */
export function lookupCount(
  counts: Readonly<Record<string, number>> | undefined,
  name: string,
): number | undefined {
  if (counts === undefined || name.length === 0) return undefined;
  if (!Object.hasOwn(counts, name)) return undefined;
  const count = counts[name];
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return undefined;
  return count;
}
