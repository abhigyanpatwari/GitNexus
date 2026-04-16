/**
 * Ruby require/require_relative import resolution — internal helpers.
 *
 * Strategy lives in configs/ruby.ts.
 * This file only contains the low-level helper used by the strategy.
 */

import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';

/**
 * Resolve a Ruby require/require_relative path to a matching .rb file (low-level helper).
 *
 * require_relative paths are pre-normalized to './' prefix by the caller.
 * require paths use suffix matching (gem-style paths like 'json', 'net/http').
 */
export function resolveRubyImportInternal(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  const pathParts = importPath.replace(/^\.\//, '').split('/').filter(Boolean);
  return suffixResolve(pathParts, normalizedFileList, allFileList, index);
}
