/**
 * Lua import resolution config.
 * Lua require() uses dot-separated module paths: require('foo.bar') → foo/bar.lua or foo/bar/init.lua
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { suffixResolve } from '../utils.js';

export const luaRequireStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  const dotPath = rawImportPath.replace(/^['"]|['"]$/g, '');
  const pathParts = dotPath.split('.').filter(Boolean);
  const resolved = suffixResolve(pathParts, ctx.normalizedFileList, ctx.allFileList, ctx.index);
  return resolved ? { kind: 'files', files: [resolved] } : null;
};

export const luaImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Lua,
  strategies: [luaRequireStrategy],
};
