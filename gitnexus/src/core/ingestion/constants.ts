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
 * Uses 2× file size, clamped between 512 KB and 32 MB.
 * Previous 256 KB fixed limit silently skipped files > ~200 KB (e.g., imgui.h at 411 KB).
 */
export const getTreeSitterBufferSize = (contentLength: number): number =>
  Math.min(Math.max(contentLength * 2, TREE_SITTER_BUFFER_SIZE), TREE_SITTER_MAX_BUFFER);
