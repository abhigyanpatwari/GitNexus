/**
 * PHP PSR-4 import resolution — internal helpers.
 *
 * Strategy lives in configs/php.ts.
 * This file contains the shared helper for PSR-4 resolution via composer.json.
 */

import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';
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
  normalizedFileList: readonly string[],
  allFileList: readonly string[],
  index?: SuffixIndex,
): string | null {
  // Normalize: replace backslashes with forward slashes
  const normalized = importPath.replace(/\\/g, '/');

  // Reject path traversal attempts (defense-in-depth — walker whitelist also prevents this)
  if (normalized.includes('..')) return null;

  if (composerConfig) {
    const sorted = getSortedPsr4(composerConfig);
    const authoritativePsr4 =
      composerConfig.authoritativePsr4 ?? new Set(sorted.map(([namespace]) => namespace));
    let matchedAuthoritativeNamespace = false;
    let hasAuthoritativeCatchAllNamespace = false;
    const ownershipPath = normalized.replace(/^\/+/, '');

    for (const [nsPrefix, dirPrefix] of sorted) {
      const nsPrefixSlash = nsPrefix.replace(/\\/g, '/').replace(/\/+$/, '');
      const isCatchAll = nsPrefixSlash === '';
      if (
        isCatchAll ||
        ownershipPath.startsWith(nsPrefixSlash + '/') ||
        ownershipPath === nsPrefixSlash
      ) {
        const isAuthoritative = authoritativePsr4.has(nsPrefix);
        matchedAuthoritativeNamespace ||= isAuthoritative;
        hasAuthoritativeCatchAllNamespace ||= isAuthoritative && isCatchAll;
        const remainder = ownershipPath.slice(nsPrefixSlash.length).replace(/^\//, '');

        // 1. Try class-style PSR-4: full path → file (e.g. App\Models\User → app/Models/User.php)
        const mappedPath =
          dirPrefix === '' ? remainder : dirPrefix + (remainder ? '/' + remainder : '');
        const filePath = mappedPath + '.php';
        if (allFiles.has(filePath)) return filePath;
        if (index) {
          const result = index.getInsensitive(filePath);
          if (result) return result;
        }

        // 2. Function/constant fallback: strip last segment (symbol name), scan namespace directory.
        //    e.g. App\Models\getUser → directory app/Models/, find first .php file in that dir.
        // A root/catch-all mapping cannot safely infer a symbol's declaring
        // file from an arbitrary sibling. The higher-level PHP resolver has
        // parsed symbol-kind and declaration evidence for function/const
        // imports; class imports must not inherit this directory heuristic.
        if (!isCatchAll && dirPrefix !== '') {
          const lastSlash = remainder.lastIndexOf('/');
          const relativeNamespace = lastSlash >= 0 ? remainder.slice(0, lastSlash) : '';
          const nsDir = relativeNamespace === '' ? dirPrefix : `${dirPrefix}/${relativeNamespace}`;

          // Prefer SuffixIndex directory lookup (O(log n + matches)) over linear scan.
          //
          // An EMPTY bucket is a final answer, not a miss to retry with the scan
          // below — which is what the `else` restores, and what this comment
          // always claimed. Re-scanning on empty was the last per-import
          // workspace traversal left in PHP resolution after #2901: any `use`
          // matching a PSR-4 prefix whose directory holds no direct `.php` child
          // (`App\Legacy\Ghost`) paid a full pass, measured at 201 traversals for
          // 200 imports.
          //
          // The bucket is a superset of what the scan can find, for BOTH index
          // shapes that reach here. A root-anchored direct child `nsDir/<x>.php`
          // has its directory exactly equal to `nsDir`, and `nsDir` is always one
          // of that directory's own suffixes — so the shared `dirMap` (keyed on
          // every directory suffix) necessarily contains it, as does the
          // root-anchored parity index `languages/php/import-target.ts` builds.
          // Empty superset therefore implies empty scan, and control falls
          // through to the next PSR-4 prefix exactly as before.
          if (index) {
            const candidates = index.getFilesInDir(nsDir, '.php');
            if (candidates.length > 0) return candidates[0];
          } else {
            // Linear scan, only when a SuffixIndex is genuinely unavailable.
            const nsDirPrefix = nsDir.endsWith('/') ? nsDir : nsDir + '/';
            for (const f of allFiles) {
              if (
                f.startsWith(nsDirPrefix) &&
                f.endsWith('.php') &&
                !f.slice(nsDirPrefix.length).includes('/')
              ) {
                return f;
              }
            }
          }
        }
      }
    }

    // A non-empty PSR-4 map is authoritative for namespaces it does not own.
    // Preserve the existing mapped-namespace fallback behavior; #2962 is the
    // conservative external-namespace gate, not a rewrite of mapped lookup.
    // A catch-all owns every namespace, so its misses remain authoritative.
    if (
      authoritativePsr4.size > 0 &&
      !composerConfig.hasUnmodeledAutoload &&
      (!matchedAuthoritativeNamespace || hasAuthoritativeCatchAllNamespace)
    ) {
      return null;
    }
  }

  // Fallback: suffix matching (works without composer.json)
  const pathParts = normalized.split('/').filter(Boolean);
  return suffixResolve(pathParts, normalizedFileList, allFileList, index);
}
