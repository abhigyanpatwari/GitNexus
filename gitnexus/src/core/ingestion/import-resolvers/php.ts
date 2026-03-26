/**
 * PHP PSR-4 import resolution.
 * Handles use-statement resolution via composer.json autoload mappings.
 */

import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';
import type { ImportResult, ResolveCtx } from './types.js';
import type { ComposerConfig } from '../language-config.js';

/** Get or compute the sorted PSR-4 entries (cached after first call). */
function getSortedPsr4(config: ComposerConfig): readonly [string, string][] {
  if (!config.psr4Sorted) {
    const sorted = [...config.psr4.entries()].sort((a, b) => b[0].length - a[0].length);
    config.psr4Sorted = sorted;
  }
  return config.psr4Sorted;
}

/**
 * Resolve a PHP use-statement import path using PSR-4 mappings (low-level helper).
 * e.g. "App\Http\Controllers\UserController" -> "app/Http/Controllers/UserController.php"
 *
 * For function/constant imports (use function App\Models\getUser), the last
 * segment is the symbol name, not a class name, so it may not map directly to
 * a file. When PSR-4 class-style resolution fails, we fall back to scanning
 * .php files in the namespace directory.
 *
 * NOTE: The function-import fallback returns the first matching .php file in the
 * namespace directory. When multiple files exist in the same namespace directory,
 * resolution is non-deterministic (depends on Set/index iteration order). This is
 * a known limitation — PHP function imports cannot be resolved to a specific file
 * without parsing all candidate files.
 */
export function resolvePhpImportInternal(
  importPath: string,
  composerConfig: ComposerConfig | null,
  allFiles: Set<string>,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  // Normalize: replace backslashes with forward slashes
  const normalized = importPath.replace(/\\/g, '/');

  // Reject path traversal attempts (defense-in-depth — walker whitelist also prevents this)
  if (normalized.includes('..')) return null;

  if (composerConfig) {
    const sorted = getSortedPsr4(composerConfig);
    for (const [nsPrefix, dirPrefix] of sorted) {
      const nsPrefixSlash = nsPrefix.replace(/\\/g, '/');
      if (normalized.startsWith(nsPrefixSlash + '/') || normalized === nsPrefixSlash) {
        const remainder = normalized.slice(nsPrefixSlash.length).replace(/^\//, '');

        // 1. Try class-style PSR-4: full path → file (e.g. App\Models\User → app/Models/User.php)
        const filePath = dirPrefix + (remainder ? '/' + remainder : '') + '.php';
        if (allFiles.has(filePath)) return filePath;
        if (index) {
          const result = index.getInsensitive(filePath);
          if (result) return result;
        }

        // 2. Function/constant fallback: strip last segment (symbol name), scan namespace directory.
        //    e.g. App\Models\getUser → directory app/Models/, find first .php file in that dir.
        const lastSlash = remainder.lastIndexOf('/');
        const nsDir = lastSlash >= 0
          ? dirPrefix + '/' + remainder.slice(0, lastSlash)
          : dirPrefix;

        // Prefer SuffixIndex directory lookup (O(log n + matches)) over linear scan
        if (index) {
          const candidates = index.getFilesInDir(nsDir, '.php');
          if (candidates.length > 0) return candidates[0];
        }

        // Fallback: linear scan (only when SuffixIndex unavailable)
        const nsDirPrefix = nsDir.endsWith('/') ? nsDir : nsDir + '/';
        for (const f of allFiles) {
          if (f.startsWith(nsDirPrefix) && f.endsWith('.php') && !f.slice(nsDirPrefix.length).includes('/')) {
            return f;
          }
        }
      }
    }
  }

  // Fallback: suffix matching (works without composer.json)
  const pathParts = normalized.split('/').filter(Boolean);
  return suffixResolve(pathParts, normalizedFileList, allFileList, index);
}

/** PHP: namespace-based resolution via composer.json PSR-4. */
export function resolvePhpImport(
  rawImportPath: string,
  _filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const resolved = resolvePhpImportInternal(rawImportPath, ctx.configs.composerConfig, ctx.allFilePaths, ctx.normalizedFileList, ctx.allFileList, ctx.index);
  return resolved ? { kind: 'files', files: [resolved] } : null;
}
