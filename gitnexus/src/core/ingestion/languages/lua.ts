/**
 * Lua Language Provider
 *
 * Assembles all Lua-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Lua traits:
 *   - importSemantics: 'wildcard-leaf' (require() returns the full module table)
 *   - No explicit visibility system — everything is public
 *   - No formal class/type system — tables used as namespace/class idiom
 *   - emitScopeCaptures: implemented (emits @scope.module for every file)
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as luaConfig } from '../type-extractors/lua.js';
import { luaExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { luaImportConfig } from '../import-resolvers/configs/lua.js';
import { LUA_QUERIES } from '../tree-sitter-queries.js';
import { emitLuaScopeCaptures } from './lua/index.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  // Standard library globals
  'print',
  'tostring',
  'tonumber',
  'type',
  'pairs',
  'ipairs',
  'next',
  'select',
  'unpack',
  'table',
  'string',
  'math',
  'io',
  'os',
  'coroutine',
  'package',
  'debug',
  'load',
  'loadfile',
  'dofile',
  'require',
  'rawget',
  'rawset',
  'rawequal',
  'rawlen',
  'setmetatable',
  'getmetatable',
  'pcall',
  'xpcall',
  'error',
  'assert',
  'collectgarbage',
  'gcinfo',
  'newproxy',
  '_G',
  '_VERSION',
  'arg',
]);

export const luaProvider = defineLanguage({
  id: SupportedLanguages.Lua,
  extensions: ['.lua'],
  treeSitterQueries: LUA_QUERIES,
  typeConfig: luaConfig,
  exportChecker: luaExportChecker,
  importResolver: createImportResolver(luaImportConfig),
  importSemantics: 'wildcard-leaf',
  builtInNames: BUILT_INS,

  // ── RFC #909 Ring 3: scope-based resolution hooks (RFC §5) ──────────
  // Lua emits at minimum @scope.module (the `(chunk)` capture) so the
  // pipeline can register each .lua file in the scope-based registry.
  emitScopeCaptures: emitLuaScopeCaptures,
});
