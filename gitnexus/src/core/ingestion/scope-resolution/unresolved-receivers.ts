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
  /**
   * Call sites dropped whose receiver was rooted OUTSIDE the indexed program,
   * by member name — `System.out.println`, `fetch(...)`, `os.environ.*`.
   *
   * Kept SEPARATE rather than filtered away. These do not make a count a lower
   * bound (there is no in-graph node an edge could have reached), but erasing
   * them at summary time would leave the persisted artifact unable to
   * distinguish "clean index" from "76 drops we judged external" — with no
   * audit path and no way back without a re-index. That is the same collapse
   * `EpistemicCauses` exists to undo, and the judgement being recorded here is a
   * heuristic, so it must stay reversible.
   */
  readonly externalCounts?: Readonly<Record<string, number>>;
  /** Total external-rooted call sites, including any beyond the cap. */
  readonly externalSites?: number;
  /**
   * Distinct member names beyond the cap, omitted from `externalCounts`. Absent
   * when nothing was dropped from that map.
   *
   * The exact twin of `omittedNames`, and it exists for the same reason. Past
   * the cap `lookupExternalCallCount` returns `undefined` for a truncated name,
   * which is indistinguishable from "this member had no external drops" — so a
   * symbol with real boundary evidence reads as having none. One map carrying a
   * truncation marker and the other silently losing entries also made the
   * persisted artifact self-contradictory: `externalSites` would exceed the sum
   * of `externalCounts` with nothing to explain the difference.
   */
  readonly externalOmittedNames?: number;
}

/**
 * Rank a name→count map and cap it at {@link MAX_UNRESOLVED_RECEIVER_MEMBERS}.
 *
 * Highest count first, name as a tiebreak so the persisted map is stable across
 * runs — an unstable ordering would churn the metadata file (and its diff) on
 * every analyze for no behavioural reason. ONE comparator, shared by the
 * in-program and external maps: two hand-copied comparators that must stay
 * identical or the artifact churns on one map and not the other is exactly the
 * drift this contract cannot tolerate.
 *
 * `omitted` is the number of distinct names past the cap, so the caller can
 * report truncation rather than silently losing entries.
 */
function rankAndCap(counts: Map<string, number>): {
  kept: [string, number][];
  omitted: number;
} {
  const ranked = [...counts.entries()].sort(
    ([aName, aCount], [bName, bCount]) => bCount - aCount || aName.localeCompare(bName),
  );
  const kept = ranked.slice(0, MAX_UNRESOLVED_RECEIVER_MEMBERS);
  return { kept, omitted: ranked.length - kept.length };
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
  const externalCounts = new Map<string, number>();
  let totalSites = 0;
  let externalSites = 0;
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
    // Routed, not discarded. External-rooted drops (`console.log(...)`,
    // `fetch(...)`) reach code this index does not contain, so there is no node
    // an edge could have pointed at and nothing was lost — they must not hedge.
    // But they stay in the artifact under their own key so the split is
    // auditable and reversible.
    //
    // `external` is a POSITIVE determination made by `classifyReceiverOrigin`
    // from a language built-in match, never a fallthrough: a receiver the
    // classifier could not place lands in `unknown`, which counts here WITH
    // `in-program`, because assuming a completeness we cannot demonstrate is
    // the unsafe direction.
    if (outcome.receiverOrigin === 'external') {
      externalSites++;
      externalCounts.set(outcome.name, (externalCounts.get(outcome.name) ?? 0) + 1);
      continue;
    }
    totalSites++;
    counts.set(outcome.name, (counts.get(outcome.name) ?? 0) + 1);
  }
  // An index whose only drops were external-rooted still reports the split, so
  // "nothing was lost" is distinguishable from "nothing was measured".
  if (totalSites === 0 && externalSites === 0) return undefined;

  const { kept, omitted: omittedNames } = rankAndCap(counts);
  const { kept: externalKept, omitted: externalOmittedNames } = rankAndCap(externalCounts);

  return {
    counts: Object.fromEntries(kept),
    totalSites,
    ...(omittedNames > 0 ? { omittedNames } : {}),
    ...(externalSites > 0
      ? {
          externalCounts: Object.fromEntries(externalKept),
          externalSites,
          ...(externalOmittedNames > 0 ? { externalOmittedNames } : {}),
        }
      : {}),
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

/**
 * Look up the EXTERNAL-rooted dropped-call count for a member name.
 *
 * Companion to `lookupUnresolvedCallCount`, and prototype-safe for the same
 * reason: the map is revived from JSON, so `constructor` / `toString` and
 * friends would otherwise return a function.
 */
export function lookupExternalCallCount(
  summary: UnresolvedReceiverSummary | undefined,
  symName: string,
): number | undefined {
  const counts = summary?.externalCounts;
  if (counts === undefined || symName.length === 0) return undefined;
  if (!Object.hasOwn(counts, symName)) return undefined;
  const sites = counts[symName];
  if (typeof sites !== 'number' || !Number.isFinite(sites) || sites <= 0) return undefined;
  return sites;
}
