/**
 * EnclosingFunctionIndex — semantic-model registry that answers
 * "which function/method/constructor lexically encloses position (file, line)?"
 * in O(log N) per query.
 *
 * Populated during the EXTRACTION phase — every Function/Method/Constructor
 * that the parsing layer adds to the SymbolTable also registers its
 * (startLine, endLine, nodeId) here. The RESOLUTION phase then never walks
 * the AST to figure out the source-side ID of a CALLS edge: it asks the
 * model with `enclosingFunctions.lookup(filePath, line)`.
 *
 * Storage: per-file array of { startLine, endLine, nodeId }, sorted lazily
 * on first lookup. Sort key is `startLine ASC, endLine DESC` so a binary
 * search for the largest `startLine ≤ line` followed by a short walk back
 * to the nearest range with `endLine ≥ line` returns the INNERMOST
 * enclosing function (handles nested closures, lambdas, local fns).
 *
 * Inserts after the first lookup invalidate the per-file sorted flag, so
 * mixed register/lookup workloads still produce correct ordering — at the
 * cost of a re-sort on the next lookup. The pipeline always finishes all
 * extraction before resolution begins, so this fast-path is what actually
 * runs in practice.
 *
 * Lifecycle: cleared by `SemanticModel.clear()` (cascade) so the index
 * never outlives the SymbolTable it mirrors.
 */

interface EnclosingRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly nodeId: string;
}

export interface EnclosingFunctionIndex {
  /**
   * Return the nodeId of the innermost function/method/constructor whose
   * lexical range contains `line` in `filePath`, or `null` when the line
   * is at module/file scope (no enclosing function was registered there).
   *
   * `line` is 1-based to match the convention used elsewhere in the
   * pipeline (`startPosition.row + 1`).
   */
  lookup(filePath: string, line: number): string | null;
}

export interface MutableEnclosingFunctionIndex extends EnclosingFunctionIndex {
  /** Register a function's lexical range. Both lines are 1-based, inclusive. */
  register(filePath: string, startLine: number, endLine: number, nodeId: string): void;
  clear(): void;
}

export const createEnclosingFunctionIndex = (): MutableEnclosingFunctionIndex => {
  const byFile = new Map<string, EnclosingRange[]>();
  // Per-file sorted-state flag. A register() after lookup() removes the
  // entry, forcing a re-sort on the next lookup().
  const sorted = new Set<string>();

  const register = (
    filePath: string,
    startLine: number,
    endLine: number,
    nodeId: string,
  ): void => {
    let arr = byFile.get(filePath);
    if (!arr) {
      arr = [];
      byFile.set(filePath, arr);
    }
    arr.push({ startLine, endLine, nodeId });
    sorted.delete(filePath);
  };

  const lookup = (filePath: string, line: number): string | null => {
    const arr = byFile.get(filePath);
    if (!arr || arr.length === 0) return null;
    if (!sorted.has(filePath)) {
      // startLine ASC, endLine DESC — outermost ranges first when starts tie.
      arr.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
      sorted.add(filePath);
    }
    // Binary search for the largest startLine ≤ line.
    let lo = 0;
    let hi = arr.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].startLine <= line) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // Walk back: the innermost containing range has the largest startLine
    // among ranges whose endLine ≥ line. With our sort order, the first
    // such range encountered while walking backwards from `best` wins.
    for (let i = best; i >= 0; i--) {
      const r = arr[i];
      if (r.endLine >= line) return r.nodeId;
    }
    return null;
  };

  const clear = (): void => {
    byFile.clear();
    sorted.clear();
  };

  return { register, lookup, clear };
};
