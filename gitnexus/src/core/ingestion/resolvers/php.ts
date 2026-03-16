/**
 * PHP PSR-4 import resolution.
 * Handles use-statement resolution via composer.json autoload mappings.
 */

import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';

/** PHP Composer PSR-4 autoload config */
export interface ComposerConfig {
  /** Map of namespace prefix -> directory (e.g., "App\\" -> "app/") */
  psr4: Map<string, string>;
}

/**
 * Resolve a PHP use-statement import path using PSR-4 mappings.
 * e.g. "App\Http\Controllers\UserController" -> "app/Http/Controllers/UserController.php"
 */
export function resolvePhpImport(
  importPath: string,
  composerConfig: ComposerConfig | null,
  allFiles: Set<string>,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  // Normalize: replace backslashes with forward slashes
  const normalized = importPath.replace(/\\/g, '/');

  // Try PSR-4 resolution if composer.json was found
  if (composerConfig) {
    // Sort namespaces by length descending (longest match wins)
    const sorted = [...composerConfig.psr4.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [nsPrefix, dirPrefix] of sorted) {
      const nsPrefixSlash = nsPrefix.replace(/\\/g, '/');
      if (normalized.startsWith(nsPrefixSlash + '/') || normalized === nsPrefixSlash) {
        const remainder = normalized.slice(nsPrefixSlash.length).replace(/^\//, '');
        const filePath = dirPrefix + (remainder ? '/' + remainder : '') + '.php';
        if (allFiles.has(filePath)) return filePath;
        if (index) {
          const result = index.getInsensitive(filePath);
          if (result) return result;
        }
      }
    }
  }

  // Fallback: suffix matching (works without composer.json)
  const pathParts = normalized.split('/').filter(Boolean);
  return suffixResolve(pathParts, normalizedFileList, allFileList, index);
}
