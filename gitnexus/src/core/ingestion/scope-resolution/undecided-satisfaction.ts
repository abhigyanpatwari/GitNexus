/**
 * Summarize interfaces whose structural-satisfaction check could not be
 * COMPLETED, for persistence in `RepoMeta` (#2873).
 *
 * The distinction this exists to preserve: an interface with no implementors in
 * the graph and an interface whose implementors could not be decided are
 * byte-identical at query time — both are zero edges. Only the first is an
 * answer. Without this record, `impact()` on a method reachable solely through
 * the second reports zero callers and calls that result `exact`.
 *
 * It rides in `RepoMeta`, not the graph, for the same reason
 * `UnresolvedReceiverSummary` does: the fact is about the ANALYSIS rather than
 * about the code, so it belongs beside the analysis, and a relationship
 * property would move `SCHEMA_FINGERPRINT` and force a full re-analyze. It also
 * keeps the marker invisible to every IMPLEMENTS consumer — MRO,
 * METHOD_IMPLEMENTS derivation, dispatch fan-out, clustering, DI — none of
 * which should see a question as an edge.
 */
import type { UndecidedSatisfaction } from './contract/scope-resolver.js';

/** Cap on distinct interfaces persisted. Far above what a healthy repo
 *  produces — an undecidable check is the exception, not the rule — but bounded
 *  so a pathological repo cannot grow the metadata file without limit.
 *  Truncation is reported, never silent: see `omittedInterfaces`. */
export const MAX_UNDECIDED_INTERFACES = 500;

export interface UndecidedSatisfactionSummary {
  /**
   * Interface name → how many candidate types went unjudged for it. Capped at
   * {@link MAX_UNDECIDED_INTERFACES} entries, highest count first.
   *
   * Keyed by NAME rather than by node id because the query side matches against
   * the interface names a boundary walk already has in hand, and because a node
   * id is only meaningful against the exact index that minted it.
   */
  readonly counts: Readonly<Record<string, number>>;
  /** Distinct interfaces that could not be fully decided, including any beyond
   *  the cap. Always the true total, so a consumer can tell `counts` is a
   *  sample rather than the whole. */
  readonly totalInterfaces: number;
  /** Total unjudged (interface, candidate) pairs, including beyond the cap. */
  readonly totalCandidates: number;
  /** Distinct interfaces beyond the cap, omitted from `counts`. Absent when
   *  nothing was dropped from the map. */
  readonly omittedInterfaces?: number;
  /**
   * Candidate type name → how many interfaces went unjudged FOR that type.
   *
   * The other side of the same fact, and the side the reported symptom needs:
   * `impact` on an implementation method never reaches the interface node —
   * the heritage edge that would take it there is exactly what went missing —
   * so an interface-keyed record alone leaves that query confidently wrong.
   * Capped like `counts`, highest first.
   */
  readonly candidateCounts: Readonly<Record<string, number>>;
  /** Distinct candidate types beyond the cap. Absent when none were dropped. */
  readonly omittedCandidates?: number;
}

/**
 * Fold the per-interface records into the persisted shape.
 *
 * Returns `undefined` when nothing was undecided — absence means "this run
 * decided everything it looked at", which is a different claim from a zeroed
 * record and must stay distinguishable at read time.
 */
export function summarizeUndecidedSatisfaction(
  undecided: readonly UndecidedSatisfaction[],
): UndecidedSatisfactionSummary | undefined {
  if (undecided.length === 0) return undefined;

  const byName = new Map<string, number>();
  const byCandidate = new Map<string, number>();
  let totalCandidates = 0;
  for (const entry of undecided) {
    totalCandidates += entry.undecidedCandidates;
    byName.set(
      entry.interfaceName,
      (byName.get(entry.interfaceName) ?? 0) + entry.undecidedCandidates,
    );
    for (const candidate of entry.candidateNames) {
      byCandidate.set(candidate, (byCandidate.get(candidate) ?? 0) + 1);
    }
  }

  // Highest count first, name as tiebreak. The tiebreak is load-bearing, not
  // cosmetic: past the cap it decides WHICH entries survive, and a
  // locale-sensitive comparison would make the persisted file depend on the
  // machine that wrote it.
  const ranked = rankAndCap(byName);
  const rankedCandidates = rankAndCap(byCandidate);

  return {
    counts: Object.fromEntries(ranked.kept),
    totalInterfaces: ranked.total,
    totalCandidates,
    candidateCounts: Object.fromEntries(rankedCandidates.kept),
    ...(ranked.omitted > 0 ? { omittedInterfaces: ranked.omitted } : {}),
    ...(rankedCandidates.omitted > 0 ? { omittedCandidates: rankedCandidates.omitted } : {}),
  };
}

function rankAndCap(byName: ReadonlyMap<string, number>): {
  kept: [string, number][];
  total: number;
  omitted: number;
} {
  const ranked = [...byName].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const kept = ranked.slice(0, MAX_UNDECIDED_INTERFACES);
  return { kept, total: ranked.length, omitted: ranked.length - kept.length };
}
