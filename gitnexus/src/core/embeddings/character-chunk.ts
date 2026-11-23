/**
 * Character-based sliding window chunking (pure, no tree-sitter dependency)
 */

export interface Chunk {
  text: string;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

/** Sliding windows with constant auxiliary memory, including line tracking. */
export function* iterateCharacterChunks(
  content: string,
  startLine: number,
  endLine: number,
  chunkSize = 1200,
  overlap = 120,
): Generator<Chunk> {
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < 1 ||
    !Number.isSafeInteger(overlap) ||
    overlap < 0
  )
    throw new Error('Invalid character chunk size or overlap');
  if (content.length <= chunkSize) {
    yield {
      text: content,
      chunkIndex: 0,
      startOffset: 0,
      endOffset: content.length,
      startLine,
      endLine,
    };
    return;
  }
  let offset = 0;
  let chunkIndex = 0;
  let relativeStart = 0;
  let relativeEnd = 0;
  let nextStartNewline = content.indexOf('\n');
  let nextEndNewline = nextStartNewline;
  while (offset < content.length) {
    const end = Math.min(offset + chunkSize, content.length);
    while (nextStartNewline >= 0 && nextStartNewline < offset) {
      relativeStart++;
      nextStartNewline = content.indexOf('\n', nextStartNewline + 1);
    }
    while (nextEndNewline >= 0 && nextEndNewline < end - 1) {
      relativeEnd++;
      nextEndNewline = content.indexOf('\n', nextEndNewline + 1);
    }
    yield {
      text: content.slice(offset, end),
      chunkIndex: chunkIndex++,
      startOffset: offset,
      endOffset: end,
      startLine: startLine + relativeStart,
      endLine: startLine + relativeEnd,
    };
    offset = end - overlap;
    if (offset >= content.length || end >= content.length) break;
    if (offset <= (chunkIndex > 1 ? end - chunkSize : 0)) offset = end;
  }
}

/** Compatibility API for callers that need all chunks. */
export const characterChunk = (
  content: string,
  startLine: number,
  endLine: number,
  chunkSize = 1200,
  overlap = 120,
): Chunk[] => {
  if (content.length <= chunkSize)
    return [
      {
        text: content,
        chunkIndex: 0,
        startOffset: 0,
        endOffset: content.length,
        startLine,
        endLine,
      },
    ];
  return [...iterateCharacterChunks(content, startLine, endLine, chunkSize, overlap)];
};
