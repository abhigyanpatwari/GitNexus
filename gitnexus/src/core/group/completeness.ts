/**
 * The one computation of "is this cross-repo answer complete?" (KTD10), and the
 * truncation vocabulary it speaks.
 *
 * A LEAF MODULE, deliberately, and that is the whole reason it exists apart from
 * `cross-impact.ts`. Three surfaces need this fold — impact, trace, and the
 * contract listing — but `cross-impact.ts` statically imports `bridge-db.ts`,
 * and through it the native LadybugDB binding. `service.ts` therefore had to
 * reach the fold through `await import('./cross-impact.js')`, which loaded that
 * entire module graph on the first `group_contracts` of every process — 44-51ms
 * and 8.4MB of RSS to run a `Set` union and a ternary, once per CLI invocation.
 *
 * Nothing here imports anything but types. Keep it that way: the moment this
 * file gains a runtime import, every consumer pays for it again.
 */
import type { GroupImpactTruncationReason, MatchType } from './types.js';

/**
 * A union rather than `Pick<GroupImpactResult, ...>` so the two states are
 * distinguishable by their `truncated` discriminant: a caller that folds these
 * fields into its own result (see `crossRepoCompleteness`) can then read
 * `truncationReason` on the truncated branch without a fallback for a value
 * that cannot be absent there.
 */
export type TruncationFields =
  | { truncated: false }
  | {
      truncated: true;
      truncationReason: GroupImpactTruncationReason;
      riskEpistemic: 'lower-bound';
    };

/**
 * Build the truncation fields every `runGroupImpact` return path shares.
 *
 * `riskEpistemic` must follow `truncated` mechanically: it is the marker that
 * tells a caller the `risk` value is a floor rather than a verdict, and
 * `mergeRisk` can only under-report once a crossing is dropped. Attaching it at
 * each return let two of the four paths set `truncated` without it, so a
 * truncated result read as complete — deriving it in one place is what keeps
 * the invariant from drifting again (#2787).
 */
export function truncationFields(
  truncated: boolean,
  // Only read on the truncated branch, so the not-truncated call sites omit it
  // rather than passing a reason that is thrown away.
  reasonIfTruncated: GroupImpactTruncationReason = 'partial',
): TruncationFields {
  if (!truncated) return { truncated: false };
  return { truncated: true, truncationReason: reasonIfTruncated, riskEpistemic: 'lower-bound' };
}

/**
 * Everything a caller needs in order to say whether a cross-repo answer is
 * complete — deliberately WITHOUT naming where any of it came from.
 *
 * `BridgeMeta` is not in this signature, and must not be: `groupContracts`
 * answers the same question from `contracts.json` (via
 * `loadContractRegistryResilient`) and never opens a bridge at all, so
 * `version` / `repoListsUnreadable` / `pairedWithDatabase` do not exist on that
 * path. Each caller computes its own `provenanceUnknown` from whatever
 * provenance IT has and passes the boolean in.
 */
export interface CrossRepoCompletenessInput {
  /**
   * Repos the sync could not extract from, and repos it found no entry for.
   * Two independent diagnostics with one consequence — none of those repos'
   * contracts are in the artifact — so they are folded into one set.
   */
  unreadableRepos?: readonly string[];
  missingRepos?: readonly string[];
  /**
   * Matching stages the sync was asked to skip. Absent or empty means it
   * suppressed none; a populated list makes the answer a floor for a reason
   * that is neither a runtime limit nor an unreadable repo.
   */
  suppressedMatchStages?: readonly string[];
  /** Computed by the caller; see `bridgeProvenanceUnknown` for the bridge one. */
  provenanceUnknown: boolean;
  /**
   * The query's DECLARED scope, not the set of repos the walk happened to
   * reach: the subgroup filter for an impact query, the two endpoint repos for
   * a trace, every member for a query that names none. An incomplete repo the
   * caller never asked about cannot make the caller's answer a floor, and
   * marking it anyway is how the marker stops meaning anything. Passing the
   * predicate in — rather than a repo list, or a subgroup — is what keeps
   * narrowing a scope a call-site change.
   */
  inScope: (repoPath: string) => boolean;
}

/** The structured triple, plus the in-scope repos that produced it. */
export type CrossRepoCompleteness = TruncationFields & {
  /**
   * In-scope repos absent from the artifact, deduped, in first-seen order.
   * Empty on a provenance-unknown answer: nothing was measured there, and
   * inventing names out of an unreadable value is not a measurement.
   */
  incompleteRepos: string[];
};

/**
 * Read a persisted `suppressedMatchStages` list.
 *
 * Sibling of `recordedRepoList` and here for the same stated reason: it had
 * lived in two files verbatim, so tightening one would silently leave the other.
 * All-or-nothing like its sibling — a stale member (this repo has already
 * retired `'bm25'` and `'embedding'`) makes the whole list unreadable rather
 * than filtering down to `[]`, which on this field would mean "measured,
 * nothing suppressed": a clean answer manufactured from a value we could not
 * read.
 */
export function recordedMatchStages(value: unknown): MatchType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const known: MatchType[] = ['exact', 'manifest', 'wildcard'];
  return value.every((v): v is MatchType => known.includes(v as MatchType)) ? value : undefined;
}

/**
 * The ONE computation of "is this cross-repo answer complete?" (KTD10).
 *
 * Three surfaces can return a partial cross-repo answer — impact, trace, and
 * the contract listing — and each used to decide for itself, in its own
 * vocabulary, which is how two of them ended up saying it in prose only. The
 * answer is the same structured triple `GroupImpactResult` already carries, so
 * an agent reading any of them learns "complete" vs "floor" the same way.
 *
 * `truncationFields` derives `riskEpistemic` from `truncated` mechanically, and
 * is reused here rather than re-implemented for the same reason it exists: the
 * marker that says "this is a floor, not a verdict" may never drift away from
 * the flag that says the answer was cut short (#2787).
 */
export function crossRepoCompleteness(input: CrossRepoCompletenessInput): CrossRepoCompleteness {
  const incompleteRepos = [
    ...new Set([...(input.unreadableRepos ?? []), ...(input.missingRepos ?? [])]),
  ].filter((repoPath) => input.inScope(repoPath));
  // An unreadable or unaccounted repo outranks a suppressed stage: it is the
  // more serious structural gap and its remedy (repair the repo, re-sync) has
  // to be the one reported. A suppressed stage only decides the reason when
  // the repo side is otherwise clean.
  const suppressed = (input.suppressedMatchStages ?? []).length > 0;
  const repoSideIncomplete = input.provenanceUnknown || incompleteRepos.length > 0;
  return {
    ...truncationFields(
      repoSideIncomplete || suppressed,
      repoSideIncomplete ? 'incomplete-sync' : 'suppressed-stage',
    ),
    incompleteRepos,
  };
}

/**
 * A recorded repo list is an array of strings. Anything else — a bare string, an
 * object, an array of objects — is a value we could not read, which is "not
 * recorded", not "none".
 *
 * ONE definition, deliberately. This gate is the predicate the whole
 * absent-vs-empty-vs-populated distinction rests on, and it applies to the same
 * two lists on both the registry and the bridge metadata. It lived in two files
 * verbatim, which meant tightening it — say, to reject blank strings — would
 * have fixed one surface and silently left the other.
 *
 * `Array.isArray` alone is not enough: only an array of strings survives
 * `cli/group.ts`'s `.join(', ')` as repo paths rather than as `[object Object]`.
 */
export function recordedRepoList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined;
}
