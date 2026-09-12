/**
 * Rendering for `gitnexus group status` rows, kept out of the Commander action
 * so it can be tested. Inline, the cell was only reachable by booting a backend
 * against a real group, which is how `STALE (-1 commits behind)` went unnoticed
 * (#3256).
 */

/** The fields of a `groupStatus` repo row the index column reads. */
export interface GroupRepoIndexRow {
  indexStale: boolean;
  commitsBehind?: number;
}

/**
 * The index column of a `group status` row. The output is unchanged except
 * for one case: a count that is not a real count renders as `?`.
 *
 * `group/service.ts` has always reported a repo with no recorded commit as
 * `{ indexStale: true, commitsBehind: -1 }`. The previous `?? '?'` fallback
 * never caught that, because `??` only falls back on `null` / `undefined`.
 */
export const formatIndexStatusCell = (row: GroupRepoIndexRow): string => {
  if (!row.indexStale) return 'OK        ';
  const n = row.commitsBehind;
  const count = typeof n === 'number' && n >= 0 ? String(n) : '?';
  return `STALE     (${count} commits behind)`;
};
