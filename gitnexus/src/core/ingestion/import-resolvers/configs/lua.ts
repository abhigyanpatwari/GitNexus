/**
 * Lua import resolution config.
 *
 * `require("a.b.c")` → module path `a/b/c`, resolved via suffixResolve
 * (tries .lua then /init.lua — see EXTENSIONS in utils.ts). Mirrors
 * rubyRequireStrategy but splits on `.` (Lua's module separator) and strips
 * surrounding quotes (the @import.source capture is a string literal).
 *
 * NOTE: inert in Phase A. The legacy parse-worker skips @import captures
 * (parse-worker.ts:1654) — IMPORTS edges are emitted by the scope-resolution
 * phase once lua/query.ts + emitScopeCaptures land (Phase B). This config is
 * provided because LanguageProvider.importResolver is a required field.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { suffixResolve } from '../utils.js';

export const luaRequireStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  const cleaned = rawImportPath.replace(/^["']|["']$/g, '');
  const pathParts = cleaned.split('.').filter(Boolean);
  if (pathParts.length === 0) return null;
  const resolved = suffixResolve(
    pathParts,
    ctx.normalizedFileList,
    ctx.allFileList,
    ctx.index,
  );
  return resolved ? { kind: 'files', files: [resolved] } : null;
};

export const luaImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Lua,
  strategies: [luaRequireStrategy],
};
