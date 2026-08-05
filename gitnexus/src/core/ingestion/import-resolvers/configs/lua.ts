/**
 * Lua import resolution config (legacy Phase A path).
 *
 * `require("a.b.c")` → module path `a/b/c`, resolved via suffixResolve
 * (tries .lua then /init.lua — see EXTENSIONS in utils.ts). Mirrors
 * rubyRequireStrategy but splits on `.` (Lua's module separator) and strips
 * surrounding quotes (the @import.source capture is a string literal).
 *
 * NOTE: bypassed when scope-resolution is active (Phase B1). IMPORTS edges are
 * emitted by the scope-resolution phase via `interpretLuaImport` +
 * `ScopeResolver.resolveImportTarget` (lua/scope-resolver.ts), not this legacy
 * `importResolver`. This config is provided because `LanguageProvider.
 * importResolver` is a required field; the suffix-resolve logic is shared
 * with the scope-resolution path through `suffixResolve`.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { suffixResolve } from '../utils.js';

export const luaRequireStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  const cleaned = rawImportPath.replace(/^["']|["']$/g, '');
  const pathParts = cleaned.split('.').filter(Boolean);
  if (pathParts.length === 0) return null;
  const resolved = suffixResolve(pathParts, ctx.normalizedFileList, ctx.allFileList, ctx.index);
  return resolved ? { kind: 'files', files: [resolved] } : null;
};

export const luaImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Lua,
  strategies: [luaRequireStrategy],
};
