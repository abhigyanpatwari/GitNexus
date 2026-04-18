/**
 * `PositionIndex` — O(log N_file) scope-at-position lookup
 * (RFC §3.1; Ring 2 SHARED #912).
 *
 * Per-file sorted array of `(range, scopeId)` entries, sorted by start
 * position ASC (`startLine`, then `startCol`). `atPosition(filePath, line,
 * col)` binary-searches for the last entry whose start ≤ (line, col), then
 * scans backward through the sorted prefix and returns the first entry
 * whose range contains the query position.
 *
 * **Why this works.** `ScopeTree`'s invariants (parent strictly contains
 * child; siblings don't overlap) guarantee that the scopes containing a
 * given point form an **ancestor chain**. When scanning backward through
 * entries sorted by start position ASC, the first scope we find that
 * contains the query is the innermost one — any deeper-starting scope
 * that also contained the query would appear *later* in the sorted array,
 * but we're only scanning entries with start ≤ query, so anything later
 * necessarily starts after the query and can't contain it.
 *
 * Expected complexity: `O(log N_file + D)` where `D` is the lexical depth
 * at the query position (typically ≤ 10). Worst-case degrades to `O(N_file)`
 * only under pathological inputs (many scopes starting at the same line).
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
   * is the backward scan through the start-position-sorted array (see
   * `findLastStartLteIndex` below) — both siblings land before the
   * upper-bound cursor, and the right sibling is scanned first. Queries at non-boundary positions between them naturally
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

  for (const bucket of entriesByFile.values()) {
    bucket.sort(compareEntry);
  }

  return wrapIndex(entriesByFile, seen.size);
}

// ─── Internals ──────────────────────────────────────────────────────────────

interface Entry {
  readonly id: ScopeId;
  readonly range: Range;
}

/**
 * Sort by start position ASC, breaking ties by end position DESC so that
 * larger (outer) scopes appear before their smaller (inner) co-starting
 * siblings in the array. Makes the backward-scan contract crisp: the
 * first containing hit from the end of the scanned prefix is the
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

function wrapIndex(entriesByFile: Map<string, Entry[]>, size: number): PositionIndex {
  return {
    get size() {
      return size;
    },
    atPosition(filePath: string, line: number, col: number): ScopeId | undefined {
      const bucket = entriesByFile.get(filePath);
      if (bucket === undefined || bucket.length === 0) return undefined;

      const endIdx = findLastStartLteIndex(bucket, line, col);
      if (endIdx < 0) return undefined;

      // Scan backward; first containing hit is innermost (see file header).
      for (let i = endIdx; i >= 0; i--) {
        const entry = bucket[i]!;
        if (endIsAtOrAfter(entry.range, line, col)) {
          // `startIsAtOrBefore` is guaranteed true by the binary search.
          return entry.id;
        }
      }
      return undefined;
    },
  };
}
