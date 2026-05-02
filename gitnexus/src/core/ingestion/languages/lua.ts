/**
 * Lua Language Provider
 *
 * Assembles all Lua-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Lua traits:
 *   - importSemantics: 'wildcard-leaf' (require() brings the module table into scope)
 *   - No static typing — type extractors are minimal
 *   - Class-like structures via table + metatable convention
 *   - Methods via function M:method() (colon syntax) and function M.func() (dot syntax)
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { luaClassConfig } from '../class-extractors/configs/lua.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as luaConfig } from '../type-extractors/lua.js';
import { luaExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { luaImportConfig } from '../import-resolvers/configs/lua.js';
import { LUA_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { luaFieldConfig } from '../field-extractors/configs/lua.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { luaMethodConfig } from '../method-extractors/configs/lua.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { luaVariableConfig } from '../variable-extractors/configs/lua.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { luaCallConfig } from '../call-extractors/configs/lua.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';
import { luaHeritageConfig } from '../heritage-extractors/configs/lua.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'print',
  'type',
  'tostring',
  'tonumber',
  'error',
  'assert',
  'pcall',
  'xpcall',
  'require',
  'dofile',
  'loadfile',
  'load',
  'rawget',
  'rawset',
  'rawequal',
  'rawlen',
  'setmetatable',
  'getmetatable',
  'select',
  'next',
  'pairs',
  'ipairs',
  'unpack',
  'table.insert',
  'table.remove',
  'table.concat',
  'table.sort',
  'string.format',
  'string.find',
  'string.match',
  'string.gsub',
  'string.sub',
  'string.len',
  'string.byte',
  'string.char',
  'string.rep',
  'string.reverse',
  'string.upper',
  'string.lower',
  'math.floor',
  'math.ceil',
  'math.abs',
  'math.max',
  'math.min',
  'math.sqrt',
  'math.random',
  'io.open',
  'io.read',
  'io.write',
  'io.close',
  'os.time',
  'os.clock',
  'os.date',
  'os.execute',
  'collectgarbage',
]);

export const luaProvider = defineLanguage({
  id: SupportedLanguages.Lua,
  extensions: ['.lua'],
  entryPointPatterns: [],
  astFrameworkPatterns: [],
  treeSitterQueries: LUA_QUERIES,
  typeConfig: luaConfig,
  exportChecker: luaExportChecker,
  importResolver: createImportResolver(luaImportConfig),
  importSemantics: 'wildcard-leaf',
  callExtractor: createCallExtractor(luaCallConfig),
  fieldExtractor: createFieldExtractor(luaFieldConfig),
  methodExtractor: createMethodExtractor(luaMethodConfig),
  variableExtractor: createVariableExtractor(luaVariableConfig),
  classExtractor: createClassExtractor(luaClassConfig),
  heritageExtractor: createHeritageExtractor(luaHeritageConfig),
  builtInNames: BUILT_INS,
});
