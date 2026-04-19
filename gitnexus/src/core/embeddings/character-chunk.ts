/**
 * Character-based sliding window chunking (pure, no tree-sitter dependency)
 */

import { buildLineIndex, resolveChunkLines } from './line-index.js';

export interface Chunk {
  text: string;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export const characterChunk = (
  content: string,
  startLine: number,
  endLine: number,
  chunkSize: number = 1200,
  overlap: number = 120,
): Chunk[] => {
  if (content.length <= chunkSize) {
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
  }

  const chunks: Chunk[] = [];
  let offset = 0;
  const lineOffsets = buildLineIndex(content);

  while (offset < content.length) {
    const end = Math.min(offset + chunkSize, content.length);
    const chunkText = content.slice(offset, end);
    const lineRange = resolveChunkLines(lineOffsets, offset, end, startLine);

    chunks.push({
      text: chunkText,
      chunkIndex: chunks.length,
      startOffset: offset,
      endOffset: end,
      startLine: lineRange.startLine,
      endLine: lineRange.endLine,
    });

    offset = end - overlap;
    if (offset >= content.length) break;
    if (end >= content.length) break;
    if (offset <= (chunks.length > 1 ? end - chunkSize : 0)) {
      offset = end;
    }
  }

  return chunks;
};
