/**
 * Standard import path resolution.
 * Handles relative imports, path alias rewriting, and generic suffix matching.
 * Used as the fallback when language-specific resolvers don't match.
 */

import type { SuffixIndex } from './utils.js';
import { tryResolveWithExtensions, suffixResolve } from './utils.js';
import { resolveRustImport } from './rust.js';
import { SupportedLanguages } from '../../../config/supported-languages.js';

/** TypeScript path alias config parsed from tsconfig.json */
export interface TsconfigPaths {
  /** Map of alias prefix -> target prefix (e.g., "@/" -> "src/") */
  aliases: Map<string, string>;
  /** Base URL for path resolution (relative to repo root) */
  baseUrl: string;
}

/** Max entries in the resolve cache. Beyond this, entries are evicted.
 *  100K entries ≈ 15MB — covers the most common import patterns. */
export const RESOLVE_CACHE_CAP = 100_000;

/**
 * Resolve an import path to a file path in the repository.
 *
 * Language-specific preprocessing is applied before the generic resolution:
 * - TypeScript/JavaScript: rewrites tsconfig path aliases
 * - Rust: converts crate::/super::/self:: to relative paths
 *
 * Java wildcards and Go package imports are handled separately in processImports
 * because they resolve to multiple files.
 */
export const resolveImportPath = (
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
  allFileList: string[],
  normalizedFileList: string[],
  resolveCache: Map<string, string | null>,
  language: SupportedLanguages,
  tsconfigPaths: TsconfigPaths | null,
  index?: SuffixIndex,
): string | null => {
  const cacheKey = `${currentFile}::${importPath}`;
  if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey) ?? null;

  const cache = (result: string | null): string | null => {
    // Evict oldest 20% when cap is reached instead of clearing all
    if (resolveCache.size >= RESOLVE_CACHE_CAP) {
      const evictCount = Math.floor(RESOLVE_CACHE_CAP * 0.2);
      const iter = resolveCache.keys();
      for (let i = 0; i < evictCount; i++) {
        const key = iter.next().value;
        if (key !== undefined) resolveCache.delete(key);
      }
    }
    resolveCache.set(cacheKey, result);
    return result;
  };

  // ---- TypeScript/JavaScript: rewrite path aliases ----
  if (
    (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) &&
    tsconfigPaths &&
    !importPath.startsWith('.')
  ) {
    for (const [aliasPrefix, targetPrefix] of tsconfigPaths.aliases) {
      if (importPath.startsWith(aliasPrefix)) {
        const remainder = importPath.slice(aliasPrefix.length);
        // Build the rewritten path relative to baseUrl
        const rewritten = tsconfigPaths.baseUrl === '.'
          ? targetPrefix + remainder
          : tsconfigPaths.baseUrl + '/' + targetPrefix + remainder;

        // Try direct resolution from repo root
        const resolved = tryResolveWithExtensions(rewritten, allFiles);
        if (resolved) return cache(resolved);

        // Try suffix matching as fallback
        const parts = rewritten.split('/').filter(Boolean);
        const suffixResult = suffixResolve(parts, normalizedFileList, allFileList, index);
        if (suffixResult) return cache(suffixResult);
      }
    }
  }

  // ---- Rust: convert module path syntax to file paths ----
  if (language === SupportedLanguages.Rust) {
    // Handle grouped imports: use crate::module::{Foo, Bar, Baz}
    // Extract the prefix path before ::{...} and resolve the module, not the symbols
    let rustImportPath = importPath;
    const braceIdx = importPath.indexOf('::{');
    if (braceIdx !== -1) {
      rustImportPath = importPath.substring(0, braceIdx);
    } else if (importPath.startsWith('{') && importPath.endsWith('}')) {
      // Top-level grouped imports: use {crate::a, crate::b}
      // Iterate each part and return the first that resolves. This function returns a single
      // string, so callers that need ALL edges must intercept before reaching here (see the
      // Rust grouped-import blocks in processImports / processImportsBatch). This fallback
      // handles any path that reaches resolveImportPath directly.
      const inner = importPath.slice(1, -1);
      const parts = inner.split(',').map(p => p.trim()).filter(Boolean);
      for (const part of parts) {
        const partResult = resolveRustImport(currentFile, part, allFiles);
        if (partResult) return cache(partResult);
      }
      return cache(null);
    }

    const rustResult = resolveRustImport(currentFile, rustImportPath, allFiles);
    if (rustResult) return cache(rustResult);
    // Fall through to generic resolution if Rust-specific didn't match
  }

  // ---- Python relative imports (PEP 328): .module, ..module, ... ----
  if (language === SupportedLanguages.Python && importPath.startsWith('.')) {
    const dotMatch = importPath.match(/^(\.+)(.*)/);
    if (dotMatch) {
      const dotCount = dotMatch[1].length;
      const modulePart = dotMatch[2]; // e.g., "models" from ".models"
      const dirParts = currentFile.split('/').slice(0, -1); // remove filename

      // Navigate up: 1 dot = same package, 2 dots = parent package, etc.
      // First dot means "current package", each additional dot goes up one level
      for (let i = 1; i < dotCount; i++) {
        dirParts.pop();
      }

      if (modulePart) {
        // from .models import User → resolve "models" relative to current package
        const modulePath = modulePart.replace(/\./g, '/');
        dirParts.push(...modulePath.split('/'));
      }

      const basePath = dirParts.join('/');
      const resolved = tryResolveWithExtensions(basePath, allFiles);
      return cache(resolved);
    }
  }

  // ---- Generic relative import resolution (./ and ../) ----
  const currentDir = currentFile.split('/').slice(0, -1);
  const parts = importPath.split('/');

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      currentDir.pop();
    } else {
      currentDir.push(part);
    }
  }

  const basePath = currentDir.join('/');

  if (importPath.startsWith('.')) {
    const resolved = tryResolveWithExtensions(basePath, allFiles);
    return cache(resolved);
  }

  // ---- Generic package/absolute import resolution (suffix matching) ----
  // Java wildcards are handled in processImports, not here
  if (importPath.endsWith('.*')) {
    return cache(null);
  }

  // C/C++ includes use actual file paths (e.g. "animal.h") — don't convert dots to slashes
  const isCpp = language === SupportedLanguages.C || language === SupportedLanguages.CPlusPlus;
  const pathLike = importPath.includes('/') || isCpp
    ? importPath
    : importPath.replace(/\./g, '/');
  const pathParts = pathLike.split('/').filter(Boolean);

  const resolved = suffixResolve(pathParts, normalizedFileList, allFileList, index);
  return cache(resolved);
};
