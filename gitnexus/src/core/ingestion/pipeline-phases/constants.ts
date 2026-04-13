/**
 * Shared constants for pipeline phases.
 *
 * Constants used by multiple phase files are defined here to avoid
 * duplication and ensure consistency.
 *
 * @module
 */

/** Max AST trees to keep in LRU cache.
 *  Shared between parse-impl.ts and cross-file-impl.ts. */
export const AST_CACHE_CAP = 50;
