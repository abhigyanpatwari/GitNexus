/**
 * Aggregate `receiver-unresolved` resolution outcomes into the small,
 * index-persisted summary that `impact()` / `context()` read to decide whether
 * their result is exact or a lower bound (#2744, the second half of #2708).
 *
 * **Why keyed by member name.** A dropped site's callee is unknown — that is
 * what "unresolved" means — so the drop cannot be attributed to any target
 * symbol. The one thing still known is the member NAME being invoked:
 * `Service(db).do_work()` tells us a call to something called `do_work` was
 * lost even though the receiver's type was not established. That is exactly
 * the granularity the epistemic signal needs: a query about `do_work` can
 * report its caller count as a lower bound, while a query about an unrelated
 * symbol stays exact.
 */

import type { ResolutionOutcome } from './resolution-outcome.js';

/** Cap on distinct member names persisted. Well above what a real repo
 *  produces (the whole point of the signal is that drops are the exception),
 *  but bounded so a pathological repo cannot grow the metadata file without
 *  limit. Truncation is reported, never silent — see `truncated`. */
export const MAX_UNRESOLVED_RECEIVER_MEMBERS = 500;

export interface UnresolvedReceiverSummary {
  /** Member name → number of call sites dropped with an untyped receiver.
   *  Capped at `MAX_UNRESOLVED_RECEIVER_MEMBERS` entries, highest count first. */
  readonly counts: Readonly<Record<string, number>>;
  /** Total dropped sites, including any beyond the cap. Always the true total,
   *  so a consumer can tell that `counts` is a sample rather than the whole. */
  readonly totalSites: number;
  /** Distinct member names beyond the cap, omitted from `counts`. Absent when
   *  nothing was dropped from the map. */
  readonly omittedNames?: number;
}

/**
 * Build the summary, or `undefined` when nothing was dropped — an index with
 * no unresolved receivers stores no key at all, so `epistemic` keeps its
 * existing "exact unless proven otherwise" behaviour for every repo that
 * resolves cleanly.
 */
export function summarizeUnresolvedReceivers(
  outcomes: readonly ResolutionOutcome[],
): UnresolvedReceiverSummary | undefined {
  const counts = new Map<string, number>();
  let totalSites = 0;
  for (const outcome of outcomes) {
    if (outcome.kind !== 'suppressed' || outcome.reason !== 'receiver-unresolved') continue;
    if (outcome.name.length === 0) continue;
    // CALL sites only. Case 0's recorder gates on the receiver's punctuation, not
    // on what the reference IS, so property reads (`d.source.kind`) and writes
    // (`x.argtypes = [...]`) are recorded alongside lost method calls — measured at
    // 25 of 124 drops on the fixture corpus. Counting them made the consumer's
    // "N call sites invoking X were dropped" literally false, and flagged symbols
    // whose CALL count was never short. `siteKind` exists to make this separable.
    // A missing `siteKind` counts as a call: the only emitter always sets it, and
    // erring toward `lower-bound` is the safe direction for an epistemic signal.
    if (outcome.siteKind !== undefined && outcome.siteKind !== 'call') continue;
    totalSites++;
    counts.set(outcome.name, (counts.get(outcome.name) ?? 0) + 1);
  }
  if (totalSites === 0) return undefined;

  // Highest count first, name as a tiebreak so the persisted map is stable
  // across runs — an unstable ordering would churn the metadata file (and its
  // diff) on every analyze for no behavioural reason.
  const ranked = [...counts.entries()].sort(
    ([aName, aCount], [bName, bCount]) => bCount - aCount || aName.localeCompare(bName),
  );
  const kept = ranked.slice(0, MAX_UNRESOLVED_RECEIVER_MEMBERS);
  const omittedNames = ranked.length - kept.length;

  return {
    counts: Object.fromEntries(kept),
    totalSites,
    ...(omittedNames > 0 ? { omittedNames } : {}),
  };
}

/**
 * Look up the dropped-CALL count for a member name.
 *
 * THE one place that reads `UnresolvedReceiverSummary.counts`. The map is
 * revived from JSON, so it carries `Object.prototype`: a bare
 * `counts[symName]` returns a FUNCTION for `constructor`, `toString`,
 * `valueOf`, `hasOwnProperty` and friends, and a `<= 0` guard does not catch it
 * because `Number(fn)` is `NaN` and `NaN <= 0` is false. `constructor` is an
 * ordinary member name in a code graph, so that was reachable in normal use and
 * interpolated a function into user-facing text.
 *
 * Returns `undefined` when the name was never recorded, and only ever returns a
 * finite positive number otherwise.
 */
export function lookupUnresolvedCallCount(
  summary: UnresolvedReceiverSummary | undefined,
  symName: string,
): number | undefined {
  const counts = summary?.counts;
  if (counts === undefined || symName.length === 0) return undefined;
  if (!Object.hasOwn(counts, symName)) return undefined;
  const sites = counts[symName];
  if (typeof sites !== 'number' || !Number.isFinite(sites) || sites <= 0) return undefined;
  return sites;
}
