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
 * - `current`  — `rev-list` answered 0.
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
 * The wire shape for staleness on every surface: MCP `list_repos`, the hot read
 * tools, and the `serve` repo routes. One builder so one fact has one shape
 * (#3232 review: "same sentinel as MCP").
 *
 * Absent for `current`, as before. `commitsBehind` is present only when git
 * actually counted it, so `diverged` carries `status` and `hint` but no number —
 * inventing one would be the silent wrong answer this exists to remove.
 */
export interface StalenessPayload {
  status: Exclude<StalenessStatus, 'current'>;
  commitsBehind?: number;
  hint?: string;
}

/**
 * Project a check into {@link StalenessPayload}, or `undefined` when there is
 * nothing to report.
 *
 * `unknown` is emitted only when `includeUnknown` is set. A listing a monitor
 * reads wants it; the hot read tools do not, because a `--skip-git` folder has
 * no history to measure and would otherwise repeat that on every response.
 */
export const stalenessPayload = (
  info: StalenessInfo | undefined,
  opts: { includeUnknown?: boolean } = {},
): StalenessPayload | undefined => {
  if (!info) return undefined;
  const status = stalenessStatus(info);
  const hint = info.hint ? { hint: info.hint } : {};
  if (status === 'current') return undefined;
  if (status === 'unknown') return opts.includeUnknown ? { status } : undefined;
  if (status === 'diverged') return { status, ...hint };
  return { status, commitsBehind: info.commitsBehind, ...hint };
};
