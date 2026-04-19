/**
 * Rust import resolution config.
 * Rust module strategy (grouped imports, crate/super/self paths), then standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { resolveRustImportInternal } from '../rust.js';

/** Rust module resolution strategy — handles grouped imports and crate/super/self paths. */
export const rustModuleStrategy: ImportResolverStrategy = (rawImportPath, filePath, ctx) => {
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

  return null;
};

export const rustImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Rust,
  strategies: [rustModuleStrategy, createStandardStrategy(SupportedLanguages.Rust)],
};
