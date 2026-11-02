/**
 * GraphNode startLine/endLine are 0-based (#2377 / line-base.ts).
 * `/api/file` ranges are also 0-indexed. Convert to 1-based only for display.
 */

export function selectedNodeFileRange(
  startLine: number,
  endLine: number | undefined,
  contextLines: number,
): { startLine: number; endLine: number } {
  return {
    startLine: Math.max(0, startLine - contextLines),
    endLine: (endLine ?? startLine) + contextLines,
  };
}

/** 1-based gutter / `data-line-number` for a 0-based GraphNode line. */
export function selectedNodeDisplayLine(storedStartLine: number): number {
  return storedStartLine + 1;
}

export function selectedNodeLineHighlighted(
  displayedLineNumber: number,
  storedStart: number,
  storedEnd: number | undefined,
): boolean {
  const displayStart = selectedNodeDisplayLine(storedStart);
  const displayEnd = selectedNodeDisplayLine(storedEnd ?? storedStart);
  return displayedLineNumber >= displayStart && displayedLineNumber <= displayEnd;
}
