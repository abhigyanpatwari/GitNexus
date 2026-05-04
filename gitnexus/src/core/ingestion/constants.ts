import { Buffer } from 'node:buffer';

/**
 * Default minimum buffer size for tree-sitter parsing (512 KB).
 * tree-sitter requires bufferSize >= file size in bytes.
 */
export const TREE_SITTER_BUFFER_SIZE = 512 * 1024;

/**
 * Maximum buffer size cap (32 MB) to prevent OOM on huge files.
 * Also used as the file-size skip threshold — files larger than this are not parsed.
 */
export const TREE_SITTER_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Compute adaptive buffer size for tree-sitter parsing.
 * Uses 2x UTF-8 byte size, clamped between 512 KB and 32 MB.
 * Keeps tree-sitter's byte-sized buffer above large ASCII and multibyte sources.
 */
export const getTreeSitterContentByteLength = (sourceText: string): number =>
  Buffer.byteLength(sourceText, 'utf8');

export const getTreeSitterBufferSize = (sourceText: string): number => {
  const byteLength = getTreeSitterContentByteLength(sourceText);
  return Math.min(Math.max(byteLength * 2, TREE_SITTER_BUFFER_SIZE), TREE_SITTER_MAX_BUFFER);
};
