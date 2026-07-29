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
