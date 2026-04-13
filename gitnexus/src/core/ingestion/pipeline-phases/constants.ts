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

// Re-export isDev from its canonical location in utils/env.ts so that
// existing phase-file imports (`from './constants.js'`) continue to work.
export { isDev } from '../utils/env.js';
