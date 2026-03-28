/**
 * Ruby require/require_relative import resolution.
 * Handles path resolution for Ruby's require and require_relative calls.
 */

import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';
import type { ImportResult, ResolveCtx } from './types.js';

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

/** Ruby: require / require_relative. */
export function resolveRubyImport(
  rawImportPath: string,
  _filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const resolved = resolveRubyImportInternal(
    rawImportPath,
    ctx.normalizedFileList,
    ctx.allFileList,
    ctx.index,
  );
  return resolved ? { kind: 'files', files: [resolved] } : null;
}
