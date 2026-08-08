/**
 * Resolve a Ruby require/require_relative import path to a repo-relative file.
 *
 * Ruby import resolution rules:
 *   - `require_relative './foo'` → resolve relative to the importing file's dir
 *   - `require 'foo'`           → suffix-match via the existing Ruby import resolver
 *   - External gems             → null (unresolvable within the repo)
 */

import { resolveRubyImportInternal } from '../../import-resolvers/ruby.js';
import { getWorkspaceFileIndex } from '../../import-resolvers/workspace-file-index.js';
import { isHeritageMarker } from '../../utils/heritage-marker.js';

export interface RubyResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}

// ─── resolveRubyImportTarget ──────────────────────────────────────────────

/**
 * ScopeResolver-shaped adapter:
 *   `(targetRaw, fromFile, allFilePaths, resolutionConfig?) → string | string[] | null`
 *
 * For relative paths (`./` or `../` — require_relative semantics), resolves
 * against the importing file's directory, trying `.rb` and `/index.rb`
 * suffixes.
 *
 * For bare requires (gem-style like `'json'`, `'serializable'`), delegates
 * to the existing `resolveRubyImportInternal` which uses suffix matching.
 *
 * Returns `null` for external gems that have no matching file in the repo.
 */
export function resolveRubyImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  _resolutionConfig?: unknown,
): string | readonly string[] | null {
  if (!targetRaw) return null;
  if (isHeritageMarker(targetRaw)) return null;

  const fromNormalized = fromFile.replace(/\\/g, '/');
  const fromDir = fromNormalized.includes('/')
    ? fromNormalized.slice(0, fromNormalized.lastIndexOf('/'))
    : '';

  // ── require_relative: relative path resolution ──────────────────────
  if (targetRaw.startsWith('./') || targetRaw.startsWith('../')) {
    const resolved = resolveRelative(targetRaw, fromDir, allFilePaths);
    return resolved;
  }

  // ── require: bare/gem-style suffix matching ─────────────────────────
  return resolveBare(targetRaw, allFilePaths);
}

// ─── internal helpers ─────────────────────────────────────────────────────

/**
 * Resolve a relative require path (`./foo`, `../bar`) against `fromDir`.
 * Tries `${resolved}.rb` then `${resolved}/index.rb`.
 */
function resolveRelative(
  targetRaw: string,
  fromDir: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  // Resolve `./` and `../` segments manually against fromDir
  const segments = (fromDir ? fromDir + '/' + targetRaw : targetRaw).split('/');
  const resolved: string[] = [];

  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }

  const resolvedPath = resolved.join('/');

  // Try direct .rb file
  const rbFile = `${resolvedPath}.rb`;
  if (allFilePaths.has(rbFile)) return rbFile;

  // Try index.rb inside directory
  const indexFile = `${resolvedPath}/index.rb`;
  if (allFilePaths.has(indexFile)) return indexFile;

  // The path might already include .rb extension
  if (resolvedPath.endsWith('.rb') && allFilePaths.has(resolvedPath)) return resolvedPath;

  return null;
}

/**
 * Resolve a bare require path (`'serializable'`, `'json'`, `'net/http'`)
 * via suffix matching using the existing Ruby import resolver.
 */
function resolveBare(targetRaw: string, allFilePaths: ReadonlySet<string>): string | null {
  // Was: two array materializations plus a full `buildSuffixIndex` per require,
  // thrown away on return — every require paid to index every file in the repo
  // (#2880). `buildSuffixIndex` is a pure function of the file set, so this is a
  // hoist, not a behaviour change.
  const { normalized, all, index } = getWorkspaceFileIndex(allFilePaths);
  return resolveRubyImportInternal(targetRaw, normalized, all, index);
}
