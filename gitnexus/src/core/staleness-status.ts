/**
 * The shape of a staleness answer, and the one wire payload every surface
 * emits for it (#3256). Pure: no git, no I/O.
 *
 * Kept apart from `git-staleness.ts` on purpose. Tests across the suite stub
 * that module with a fixed `vi.mock` factory so nothing shells out to git; a
 * pure helper exported from it would come back `undefined` under every such
 * stub. Here it is imported for real wherever the git probes are mocked.
 */

/**
 * What a staleness check was able to establish.
 *
 * `isStale` / `commitsBehind` alone cannot say "could not tell": every git
 * failure collapses into `{ isStale: false, commitsBehind: 0 }`. That is
 * deliberate — pinned by the fail-open tests, because the hot read tools must
 * never fail or nag on an index they cannot measure — but it also made a
 * provably stale index indistinguishable from a fresh one. `status` is the
 * additive channel that separates them for a caller that wants to act on it:
 *
 * - `current`  — the index is at HEAD: `rev-list` answered 0, or it could not
 *   answer but HEAD alone resolved to the indexed commit.
 * - `behind`   — `rev-list` answered N > 0; `commitsBehind` is N.
 * - `diverged` — `rev-list` could not answer, but HEAD resolved and is not the
 *   indexed commit. The index is provably not at HEAD; only the count is
 *   unknown. A branch-pinned `serve` clone reaches this once git prunes the
 *   commit a failed re-index left behind — the pinned update is a
 *   `fetch --depth 1`, which orphans it — and a rewritten history reaches it
 *   directly. It is the rule the Claude hook already applies:
 *   HEAD !== lastCommit.
 * - `unknown`  — HEAD could not be resolved at all: not a git repository, git
 *   timed out, or no commit was recorded.
 *
 * `isStale` and `commitsBehind` keep their historical values in every case, so
 * no existing consumer changes behaviour unless it reads `status`.
 */
export type StalenessStatus = 'current' | 'behind' | 'diverged' | 'unknown';

export interface StalenessInfo {
  isStale: boolean;
  commitsBehind: number;
  hint?: string;
  /**
   * Always set by `checkStaleness` and `checkStalenessAsync`. Optional on the
   * type so a hand-built info (tests, legacy literals) still compiles; read it
   * through {@link stalenessStatus}, which derives it from `isStale` when absent.
   */
  status?: StalenessStatus;
}

/** `info.status`, or the answer `isStale` implies for an info built without one. */
export const stalenessStatus = (info: StalenessInfo): StalenessStatus =>
  info.status ?? (info.isStale ? 'behind' : 'current');

/**
 * The ref an index represents, as the resolved repo handle already knows it.
 * `lastCommit` and `indexedAt` are always recorded on a handle; `branch` is
 * best-effort — a plain analyze stamps the checked-out branch, but a detached
 * HEAD, a non-git folder, or a legacy index that never recorded one leaves it
 * absent (`run-analyze.ts`: `branchLabel ?? existingMeta?.branch`).
 */
export interface IndexedRef {
  branch?: string;
  lastCommit: string;
  indexedAt: string;
}

/**
 * The wire shape for staleness on every surface: MCP `list_repos`, the hot read
 * tools, and the `serve` repo routes. One builder so one fact has one shape
 * (#3232 review: "same sentinel as MCP").
 *
 * Two forms, chosen by whether the caller supplies a {@link IndexedRef}:
 *
 * - **Without a ref** — absent for `current`, as before. That is what
 *   `list_repos` and the `serve` routes emit; they already report the ref
 *   through their own top-level `branch` / `lastCommit` / `indexedAt` fields
 *   (#3226), so repeating it inside the payload would duplicate it.
 * - **With a ref** — emitted for EVERY status, naming the index it describes.
 *   The hot read tools have nowhere else to put it: `attachToolStaleness` may
 *   add exactly one key to an arbitrary tool result. Without it `current` is
 *   indistinguishable between an index of the default branch and one of some
 *   feature branch, because `current` is a statement about a *ref*, not about
 *   the repository (#3291).
 *
 * `commitsBehind` is present only when git actually counted it, so `diverged`
 * carries `status` and `hint` but no number — inventing one would be the silent
 * wrong answer this exists to remove.
 */
export interface StalenessPayload {
  status: StalenessStatus;
  /** Ref identity — present only on the ref-carrying (hot read tool) form. */
  branch?: string;
  lastCommit?: string;
  indexedAt?: string;
  /**
   * What `commitsBehind` is counted against: the checked-out HEAD of the clone
   * this index was built from, never the remote or the default branch.
   */
  measuredAgainst?: 'HEAD';
  commitsBehind?: number;
  hint?: string;
}

/**
 * Project a check into {@link StalenessPayload}, or `undefined` when there is
 * nothing to report.
 *
 * `unknown` is emitted only when `includeUnknown` is set. A listing a monitor
 * reads wants it; the no-ref hot-tool form does not, because a `--skip-git`
 * folder has no history to measure and would otherwise repeat that on every
 * response. The ref-carrying form reports it regardless — which index answered
 * is knowable even when its freshness is not.
 */
export const stalenessPayload = (
  info: StalenessInfo | undefined,
  opts: { includeUnknown?: boolean; ref?: IndexedRef } = {},
): StalenessPayload | undefined => {
  if (!info) return undefined;
  const status = stalenessStatus(info);
  const hint = info.hint ? { hint: info.hint } : {};

  // No ref: bit-identical to the pre-#3291 output for every status. This is
  // what keeps `list_repos` and both `serve` routes byte-stable, and their
  // exact-match tests passing unmodified.
  if (!opts.ref) {
    if (status === 'current') return undefined;
    if (status === 'unknown') return opts.includeUnknown ? { status } : undefined;
    if (status === 'diverged') return { status, ...hint };
    return { status, commitsBehind: info.commitsBehind, ...hint };
  }

  const ref = {
    ...(opts.ref.branch ? { branch: opts.ref.branch } : {}),
    lastCommit: opts.ref.lastCommit,
    indexedAt: opts.ref.indexedAt,
    measuredAgainst: 'HEAD' as const,
  };
  if (status === 'current' || status === 'unknown') return { status, ...ref };
  if (status === 'diverged') return { status, ...ref, ...hint };
  return { status, ...ref, commitsBehind: info.commitsBehind, ...hint };
};
