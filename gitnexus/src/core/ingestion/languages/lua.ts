/**
 * Lua language provider.
 *
 * Phase A (legacy DAG): emits Function/Method DEFINITION nodes from
 * LUA_QUERIES — `function foo()`, `local function foo()`, `function Obj:m()`
 * / `function Obj.m()`.
 *
 * Phase B1 (scope resolution): `emitScopeCaptures` (lua/captures.ts) runs the
 * scope query (lua/query.ts) and the central ScopeExtractor builds the scope
 * tree + declarations + imports + reference sites. `interpretImport` turns
 * require()'s `@import.source` into a wildcard ParsedImport; the legacy
 * `importResolver` (luaRequireStrategy / suffixResolve) is bridged to resolve
 * `targetRaw` → file (no separate resolveImportTarget needed, mirroring
 * Ruby). This unlocks CALLS edges (from @reference.call.*) and IMPORTS edges.
 *
 * Still Phase B (pending): middleclass `class("Name", Parent)` → Class nodes
 * + EXTENDS + HAS_METHOD (call-router pattern); receiverBinding/arity polish
 * for higher-quality call-target linking.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { LUA_QUERIES } from '../tree-sitter-queries.js';
import { typeConfig as luaTypeConfig } from '../type-extractors/lua.js';
import { luaExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { luaImportConfig } from '../import-resolvers/configs/lua.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { luaCallConfig } from '../call-extractors/configs/lua.js';
import { emitLuaScopeCaptures, interpretLuaImport } from './lua/index.js';

export const luaProvider = defineLanguage({
  id: SupportedLanguages.Lua,
  extensions: ['.lua'],
  treeSitterQueries: LUA_QUERIES,
  typeConfig: luaTypeConfig,
  exportChecker: luaExportChecker,
  importResolver: createImportResolver(luaImportConfig),
  callExtractor: createCallExtractor(luaCallConfig),
  emitScopeCaptures: emitLuaScopeCaptures,
  interpretImport: interpretLuaImport,
});
