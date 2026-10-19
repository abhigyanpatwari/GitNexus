/**
 * `PositionIndex` — O(log N_file) scope-at-position lookup
 * (RFC §3.1; Ring 2 SHARED #912).
 *
 * Per-file sorted array of `(range, scopeId)` entries, sorted by start
 * position ASC (`startLine`, then `startCol`). `atPosition(filePath, line,
 * col)` binary-searches for the last entry whose start ≤ (line, col), then
 * searches a range-maximum tree for the rightmost entry that has not ended.
 *
 * **Why this works.** `ScopeTree`'s invariants (parent strictly contains
 * child; siblings don't overlap) guarantee that the scopes containing a
 * given point form an **ancestor chain**. Among entries whose start is at or
 * before the query, the last containing entry is innermost: a deeper-starting
 * scope would appear later in the sorted array. The maximum-end tree finds
 * that last match without visiting completed scopes individually.
 *
 * The maximum end position lets a query skip an entire interval of completed
 * scopes at once, including completed nested scopes. Queries take
 * `O(log N_file)`; the auxiliary tree takes linear space and construction time
 * after sorting. Repeated outer reads never rescan all preceding siblings.
 *
 * **Line/column conventions.** Matches `Range` in `types.ts`: lines are
 * 1-based, columns are 0-based. Ranges are **inclusive on both ends** —
 * a scope whose `endLine:endCol` equals the query position still contains
 * it. That matches how tree-sitter captures bodies (closing brace
 * included) and how closed PR #902's `enclosingFunctions` behaved.
 */

import type { Range, Scope, ScopeId } from './types.js';

export interface PositionIndex {
  /** Total scope entries indexed across all files. */
  readonly size: number;
  /**
   * Innermost scope containing `(line, col)` in `filePath`, or `undefined`
   * when nothing contains it (position before file start, after file end,
   * or filePath not indexed).
   *
   * **Touching-boundary semantics.** Ranges are inclusive on both ends.
   * When two sibling scopes share a boundary point — e.g.
   * `[5:0, 10:0]` and `[10:0, 15:0]`, which is legal under `ScopeTree`'s
   * non-overlap invariant — a query at the shared point `(10, 0)` is
   * contained by **both**. The innermost-wins tie-break rule applies as
   * usual: since neither is nested inside the other, the one that
   * **starts latest** wins, i.e. the **right** sibling. The mechanism
   * is the rightmost match in the start-position-sorted array — both siblings
   * land before the upper-bound cursor, and the right sibling wins. Queries at non-boundary positions between them naturally
   * fall to the unique containing scope.
   */
  atPosition(filePath: string, line: number, col: number): ScopeId | undefined;
}

/**
 * Build a `PositionIndex` from a flat list of `Scope` records.
 *
 * Duplicate `id`s are tolerated and deduplicated — the caller's
 * `ScopeTree.buildScopeTree` is the authoritative validator of scope
 * identity, and the position index does not need to re-check that
 * invariant.
 */
export function buildPositionIndex(scopes: readonly Scope[]): PositionIndex {
  const entriesByFile = new Map<string, Entry[]>();
  const seen = new Set<ScopeId>();

  for (const scope of scopes) {
    if (seen.has(scope.id)) continue;
    seen.add(scope.id);

    let bucket = entriesByFile.get(scope.filePath);
    if (bucket === undefined) {
      bucket = [];
      entriesByFile.set(scope.filePath, bucket);
    }
    bucket.push({ id: scope.id, range: scope.range });
  }

  const files = new Map<string, FileIndex>();
  for (const [filePath, bucket] of entriesByFile) {
    bucket.sort(compareEntry);
    files.set(filePath, { entries: bucket, maximumEnds: buildEndIndex(bucket) });
  }

  return wrapIndex(files, seen.size);
}

// ─── Internals ──────────────────────────────────────────────────────────────

interface Entry {
  readonly id: ScopeId;
  readonly range: Range;
}

interface FileIndex {
  readonly entries: readonly Entry[];
  readonly maximumEnds: readonly Range[];
}

/** Each tree node stores the latest end in its contiguous entry interval. */
function buildEndIndex(entries: readonly Entry[]): Range[] {
  const maximumEnds: Range[] = [];
  const build = (node: number, first: number, last: number): Range => {
    if (first === last) return (maximumEnds[node] = entries[first]!.range);
    const middle = (first + last) >>> 1;
    const left = build(node * 2, first, middle);
    const right = build(node * 2 + 1, middle + 1, last);
    return (maximumEnds[node] = endIsAtOrAfter(left, right.endLine, right.endCol) ? left : right);
  };
  build(1, 0, entries.length - 1);
  return maximumEnds;
}

/**
 * Sort by start position ASC, breaking ties by end position DESC so that
 * larger (outer) scopes appear before their smaller (inner) co-starting
 * siblings in the array. The rightmost containing entry is the
 * innermost scope.
 */
function compareEntry(a: Entry, b: Entry): number {
  if (a.range.startLine !== b.range.startLine) return a.range.startLine - b.range.startLine;
  if (a.range.startCol !== b.range.startCol) return a.range.startCol - b.range.startCol;
  if (a.range.endLine !== b.range.endLine) return b.range.endLine - a.range.endLine;
  return b.range.endCol - a.range.endCol;
}

/** Whether `(line, col)` is at or after `range`'s start. */
function startIsAtOrBefore(range: Range, line: number, col: number): boolean {
  if (range.startLine < line) return true;
  if (range.startLine > line) return false;
  return range.startCol <= col;
}

/** Whether `(line, col)` is at or before `range`'s end (inclusive). */
function endIsAtOrAfter(range: Range, line: number, col: number): boolean {
  if (range.endLine > line) return true;
  if (range.endLine < line) return false;
  return range.endCol >= col;
}

/**
 * Return the largest index `i` in `arr` where `arr[i].range` starts at or
 * before `(line, col)`. Returns `-1` if no entry starts ≤ the query.
 *
 * Classic "upper bound - 1" binary search: find the first entry that
 * starts *after* the query, then step back one.
 */
function findLastStartLteIndex(arr: readonly Entry[], line: number, col: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (startIsAtOrBefore(arr[mid]!.range, line, col)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - 1;
}

function findLastContainingEntry(
  file: FileIndex,
  upper: number,
  line: number,
  col: number,
  node = 1,
  first = 0,
  last = file.entries.length - 1,
): number {
  if (first > upper || !endIsAtOrAfter(file.maximumEnds[node]!, line, col)) return -1;
  if (first === last) return first;
  const middle = (first + last) >>> 1;
  if (upper > middle) {
    const right = findLastContainingEntry(file, upper, line, col, node * 2 + 1, middle + 1, last);
    if (right >= 0) return right;
  }
  return findLastContainingEntry(file, upper, line, col, node * 2, first, middle);
}

function wrapIndex(files: ReadonlyMap<string, FileIndex>, size: number): PositionIndex {
  return {
    get size() {
      return size;
    },
    atPosition(filePath: string, line: number, col: number): ScopeId | undefined {
      const file = files.get(filePath);
      if (file === undefined) return undefined;

      const endIdx = findLastStartLteIndex(file.entries, line, col);
      if (endIdx < 0) return undefined;

      const match = findLastContainingEntry(file, endIdx, line, col);
      return match < 0 ? undefined : file.entries[match]!.id;
    },
  };
}
