/**
 * Aggregate free calls dropped at a competing-binding barrier into the small,
 * index-persisted summary that `impact()` / `context()` read to decide whether
 * their result is exact or a lower bound.
 *
 * A provider blocks a name whose bindings compete — `try: from a import f`
 * with an `except ImportError: f = None` fallback — rather than guess which one
 * runs, so no CALLS edge reaches any candidate. That barrier is intended; the
 * silence was not: the real target's caller count read as an exact zero,
 * indistinguishable from an unused function.
 *
 * Keyed by name for the same reason as `summarizeUnresolvedReceivers`: the drop
 * names no target, only the name invoked. Kept separate from that summary
 * because its consumer's note blames an untyped receiver, which is not the
 * cause here.
 */

import { rankAndCap, lookupCount } from './summary-maps.js';

import type { ResolutionOutcome } from './resolution-outcome.js';

/** Cap on distinct names persisted, matching the receiver summary's. Truncation
 *  is reported through `omittedNames`, never silent. */
export const MAX_COMPETING_BINDING_NAMES = 500;

export interface CompetingBindingDropSummary {
  /** Name → number of call sites dropped at a competing-binding barrier.
   *  Capped at `MAX_COMPETING_BINDING_NAMES` entries, highest count first. */
  readonly counts: Readonly<Record<string, number>>;
  /** Total dropped sites, including any beyond the cap. */
  readonly totalSites: number;
  /** Distinct names beyond the cap, omitted from `counts`. Absent when nothing
   *  was dropped from the map. */
  readonly omittedNames?: number;
}

/**
 * Build the summary, or `undefined` when no barrier dropped a call — an index
 * with no such drops stores no key, so `epistemic` stays exact for it.
 */
export function summarizeCompetingBindingDrops(
  outcomes: readonly ResolutionOutcome[],
): CompetingBindingDropSummary | undefined {
  const counts = new Map<string, number>();
  // One site can be recorded under several names (an aliased import's local
  // spelling and its source name), so sites are counted by position.
  const sites = new Set<string>();
  for (const outcome of outcomes) {
    if (
      outcome.kind !== 'suppressed' ||
      outcome.reason !== 'competing-binding-barrier' ||
      outcome.siteKind !== 'call' ||
      outcome.name.length === 0
    )
      continue;
    const { startLine, startCol, endLine, endCol } = outcome.range;
    sites.add(`${outcome.filePath}:${startLine}:${startCol}:${endLine}:${endCol}`);
    counts.set(outcome.name, (counts.get(outcome.name) ?? 0) + 1);
  }
  const totalSites = sites.size;
  if (totalSites === 0) return undefined;
  const { kept, omitted: omittedNames } = rankAndCap(counts, MAX_COMPETING_BINDING_NAMES);
  return {
    counts: Object.fromEntries(kept),
    totalSites,
    ...(omittedNames > 0 ? { omittedNames } : {}),
  };
}

/** Prototype-safe dropped-call count for a name; see `lookupCount`. */
export function lookupCompetingBindingDropCount(
  summary: CompetingBindingDropSummary | undefined,
  symName: string,
): number | undefined {
  return lookupCount(summary?.counts, symName);
}
