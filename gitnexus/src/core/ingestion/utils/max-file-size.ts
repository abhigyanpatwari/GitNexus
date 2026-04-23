import { TREE_SITTER_MAX_BUFFER } from '../constants.js';

/** Default threshold (512 KB). Files larger than this are skipped by the walker. */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 512 * 1024;

/** Hard upper bound — tree-sitter refuses buffers above this regardless. */
export const MAX_FILE_SIZE_UPPER_BOUND_BYTES = TREE_SITTER_MAX_BUFFER;

const warned = new Set<string>();

const warnOnce = (key: string, message: string): void => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
};

/**
 * Resolve the effective file-size skip threshold (bytes) for the walker.
 * Reads `GITNEXUS_MAX_FILE_SIZE` (KB). Invalid values fall back to the default
 * and emit a one-time warning. Values above the tree-sitter ceiling are clamped.
 */
export const getMaxFileSizeBytes = (): number => {
  const raw = process.env.GITNEXUS_MAX_FILE_SIZE;
  if (!raw) return DEFAULT_MAX_FILE_SIZE_BYTES;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    warnOnce(
      `invalid:${raw}`,
      `  GITNEXUS_MAX_FILE_SIZE must be a positive integer (KB), got "${raw}" — using default ${DEFAULT_MAX_FILE_SIZE_BYTES / 1024}KB`,
    );
    return DEFAULT_MAX_FILE_SIZE_BYTES;
  }

  const bytes = parsed * 1024;
  if (bytes > MAX_FILE_SIZE_UPPER_BOUND_BYTES) {
    warnOnce(
      `clamp:${raw}`,
      `  GITNEXUS_MAX_FILE_SIZE=${parsed}KB exceeds tree-sitter ceiling (${MAX_FILE_SIZE_UPPER_BOUND_BYTES / 1024}KB) — clamping`,
    );
    return MAX_FILE_SIZE_UPPER_BOUND_BYTES;
  }
  return bytes;
};

/** Test-only: reset the warn-once cache so repeated test runs can re-observe warnings. */
export const _resetMaxFileSizeWarnings = (): void => {
  warned.clear();
};
