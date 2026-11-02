/**
 * Rendering for `gitnexus group status` rows, kept out of the Commander action
 * so it can be tested. Inline, the cell was only reachable by booting a backend
 * against a real group, which is how `STALE (-1 commits behind)` went unnoticed
 * (#3256).
 */
import type { StalenessStatus } from '../core/staleness-status.js';

/** The fields of a `groupStatus` repo row the index column reads. */
export interface GroupRepoIndexRow {
  indexStale: boolean;
  commitsBehind?: number;
  status?: StalenessStatus;
}

/**
 * The index column of a `group status` row. Diverged indexes differ from HEAD
 * without a forward commit count; an unavailable count renders as `?`.
 *
 * `group/service.ts` has always reported a repo with no recorded commit as
 * `{ indexStale: true, commitsBehind: -1 }`. The previous `?? '?'` fallback
 * never caught that, because `??` only falls back on `null` / `undefined`.
 */
export const formatIndexStatusCell = (row: GroupRepoIndexRow): string => {
  if (!row.indexStale) return 'OK        ';
  if (row.status === 'diverged') return 'STALE     (index differs from HEAD)';
  const n = row.commitsBehind;
  const count = typeof n === 'number' && n >= 0 ? String(n) : '?';
  return `STALE     (${count} commits behind)`;
};
