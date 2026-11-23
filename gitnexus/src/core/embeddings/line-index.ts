export interface ResolvedLineRange {
  startLine: number;
  endLine: number;
}

export const buildLineIndex = (content: string): Int32Array => {
  // Allocate the final packed index directly; a temporary number[] costs much
  // more than the source for files with millions of short lines.
  let count = 1;
  for (let i = content.indexOf('\n'); i >= 0; i = content.indexOf('\n', i + 1)) count++;
  const offsets = new Int32Array(count);
  let line = 1;
  for (let i = content.indexOf('\n'); i >= 0; i = content.indexOf('\n', i + 1))
    offsets[line++] = i + 1;
  return offsets;
};

const clampOffset = (lineOffsets: Int32Array, charOffset: number): number => {
  if (lineOffsets.length === 0) return 0;
  const maxOffset = lineOffsets[lineOffsets.length - 1];
  if (charOffset < 0) return 0;
  if (charOffset > maxOffset) return maxOffset;
  return charOffset;
};

export const lineFromOffset = (lineOffsets: Int32Array, charOffset: number): number => {
  if (lineOffsets.length === 0) return 0;

  const clamped = clampOffset(lineOffsets, charOffset);
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= clamped) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

export const resolveChunkLines = (
  lineOffsets: Int32Array,
  startOffset: number,
  endOffset: number,
  baseStartLine: number,
): ResolvedLineRange => {
  const relativeStartLine = lineFromOffset(lineOffsets, startOffset);
  const effectiveEndOffset = endOffset > startOffset ? endOffset - 1 : startOffset;
  const relativeEndLine = lineFromOffset(lineOffsets, effectiveEndOffset);

  return {
    startLine: baseStartLine + relativeStartLine,
    endLine: baseStartLine + relativeEndLine,
  };
};
