/**
 * Lua import resolution config.
 *
 * Lua's `require("foo.bar")` converts dots to path separators:
 *   require("scripts.combat.player") → scripts/combat/player.lua
 *
 * We apply a simple suffix-match after converting dot-separators.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { suffixResolve } from '../utils.js';

/** Lua require() resolution strategy. Dots in the module name map to path separators. */
export const luaRequireStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  // Strip surrounding quotes if present (e.g. '"scripts.player"' → 'scripts.player')
  const stripped = rawImportPath.replace(/^['"]|['"]$/g, '');
  // Convert Lua dot-separators to path separators, then append .lua if missing.
  const pathParts = stripped.split('.').filter(Boolean);
  const resolved = suffixResolve(pathParts, ctx.normalizedFileList, ctx.allFileList, ctx.index);
  return resolved ? { kind: 'files', files: [resolved] } : null;
};

export const luaImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Lua,
  strategies: [luaRequireStrategy],
};
