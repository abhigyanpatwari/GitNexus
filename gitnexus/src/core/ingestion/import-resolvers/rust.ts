/**
 * Rust module import resolution.
 * Handles crate::, super::, self:: prefix paths and :: separators.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResult, ResolveCtx } from './types.js';
import { resolveStandard } from './standard.js';

/**
 * Resolve Rust use-path to a file (low-level helper).
 * Handles crate::, super::, self:: prefixes and :: path separators.
 */
export function resolveRustImportInternal(
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
): string | null {
  let rustPath: string;

  if (importPath.startsWith('crate::')) {
    // crate:: resolves from src/ directory (standard Rust layout)
    rustPath = importPath.slice(7).replace(/::/g, '/');

    // Try from src/ (standard layout)
    const fromSrc = tryRustModulePath('src/' + rustPath, allFiles);
    if (fromSrc) return fromSrc;

    // Try from repo root (non-standard)
    const fromRoot = tryRustModulePath(rustPath, allFiles);
    if (fromRoot) return fromRoot;

    return null;
  }

  if (importPath.startsWith('super::')) {
    // super:: = parent directory of current file's module
    const currentDir = currentFile.split('/').slice(0, -1);
    currentDir.pop(); // Go up one level for super::
    rustPath = importPath.slice(7).replace(/::/g, '/');
    const fullPath = [...currentDir, rustPath].join('/');
    return tryRustModulePath(fullPath, allFiles);
  }

  if (importPath.startsWith('self::')) {
    // self:: = current module's directory
    const currentDir = currentFile.split('/').slice(0, -1);
    rustPath = importPath.slice(6).replace(/::/g, '/');
    const fullPath = [...currentDir, rustPath].join('/');
    return tryRustModulePath(fullPath, allFiles);
  }

  // Bare path without prefix (e.g., from a use in a nested module)
  // Convert :: to / and try suffix matching
  if (importPath.includes('::')) {
    rustPath = importPath.replace(/::/g, '/');
    return tryRustModulePath(rustPath, allFiles);
  }

  return null;
}

/**
 * Try to resolve a Rust module path to a file.
 * Tries: path.rs, path/mod.rs, and with the last segment stripped
 * (last segment might be a symbol name, not a module).
 */
export function tryRustModulePath(modulePath: string, allFiles: Set<string>): string | null {
  // Try direct: path.rs
  if (allFiles.has(modulePath + '.rs')) return modulePath + '.rs';
  // Try directory: path/mod.rs
  if (allFiles.has(modulePath + '/mod.rs')) return modulePath + '/mod.rs';
  // Try path/lib.rs (for crate root)
  if (allFiles.has(modulePath + '/lib.rs')) return modulePath + '/lib.rs';

  // The last segment might be a symbol (function, struct, etc.), not a module.
  // Strip it and try again.
  const lastSlash = modulePath.lastIndexOf('/');
  if (lastSlash > 0) {
    const parentPath = modulePath.substring(0, lastSlash);
    if (allFiles.has(parentPath + '.rs')) return parentPath + '.rs';
    if (allFiles.has(parentPath + '/mod.rs')) return parentPath + '/mod.rs';
  }

  return null;
}

/** Rust: expand grouped imports: use {crate::a, crate::b} and use crate::models::{User, Repo}. */
export function resolveRustImport(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  // Top-level grouped: use {crate::a, crate::b}
  if (rawImportPath.startsWith('{') && rawImportPath.endsWith('}')) {
    const inner = rawImportPath.slice(1, -1);
    const parts = inner
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const resolved: string[] = [];
    for (const part of parts) {
      const r = resolveRustImportInternal(filePath, part, ctx.allFilePaths);
      if (r) resolved.push(r);
    }
    return resolved.length > 0 ? { kind: 'files', files: resolved } : null;
  }

  // Scoped grouped: use crate::models::{User, Repo}
  const braceIdx = rawImportPath.indexOf('::{');
  if (braceIdx !== -1 && rawImportPath.endsWith('}')) {
    const pathPrefix = rawImportPath.substring(0, braceIdx);
    const braceContent = rawImportPath.substring(braceIdx + 3, rawImportPath.length - 1);
    const items = braceContent
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const resolved: string[] = [];
    for (const item of items) {
      // Handle `use crate::models::{User, Repo as R}` — strip alias for resolution
      const itemName = item.includes(' as ') ? item.split(' as ')[0].trim() : item;
      const r = resolveRustImportInternal(filePath, `${pathPrefix}::${itemName}`, ctx.allFilePaths);
      if (r) resolved.push(r);
    }
    if (resolved.length > 0) return { kind: 'files', files: resolved };
    // Fallback: resolve the prefix path itself (e.g. crate::models -> models.rs)
    const prefixResult = resolveRustImportInternal(filePath, pathPrefix, ctx.allFilePaths);
    if (prefixResult) return { kind: 'files', files: [prefixResult] };
  }

  return resolveStandard(rawImportPath, filePath, ctx, SupportedLanguages.Rust);
}
