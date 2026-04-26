/**
 * Zig Language Provider
 *
 * Mirrors the Rust provider — Zig is the closest analog (systems language,
 * per-symbol named imports via `const X = @import("...")`, no inheritance,
 * no MRO).
 *
 * Key Zig traits:
 *   - importSemantics: 'named' (each `@import` binds to one local name)
 *   - mroStrategy: 'first-wins' (no inheritance, MRO is irrelevant)
 *   - namedBindingExtractor: returns the local-name → exported-name pair
 *     for the enclosing variable_declaration of the @import call.
 *
 * Container types (struct / enum / union) are anonymous values bound to
 * a variable_declaration. The class extractor disambiguates these from
 * ordinary variable declarations by inspecting the RHS.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createCallExtractor } from '../call-extractors/generic.js';
import { zigCallConfig } from '../call-extractors/configs/zig.js';
import { createClassExtractor } from '../class-extractors/generic.js';
import { zigClassConfig } from '../class-extractors/configs/zig.js';
import { zigExportChecker } from '../export-detection.js';
import { zigFieldExtractor } from '../field-extractors/zig.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';
import { zigImportConfig } from '../import-resolvers/configs/zig.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { defineLanguage } from '../language-provider.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { zigMethodConfig } from '../method-extractors/configs/zig.js';
import { extractZigNamedBindings } from '../named-bindings/zig.js';
import { ZIG_QUERIES } from '../tree-sitter-queries.js';
import { typeConfig as zigConfig } from '../type-extractors/zig.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { zigVariableConfig } from '../variable-extractors/configs/zig.js';

// Zig builtins that should never be treated as user-defined call targets.
// All `@`-prefixed names plus a handful of conventionally noisy stdlib helpers.
const BUILT_INS: ReadonlySet<string> = new Set([
  // Core builtins (compile-time intrinsics)
  '@import',
  '@intCast',
  '@as',
  '@ptrCast',
  '@sizeOf',
  '@alignOf',
  '@TypeOf',
  '@typeInfo',
  '@typeName',
  '@field',
  '@hasField',
  '@hasDecl',
  '@compileError',
  '@compileLog',
  '@panic',
  '@truncate',
  '@bitCast',
  '@floatCast',
  '@floatFromInt',
  '@intFromFloat',
  '@intFromBool',
  '@boolFromInt',
  '@enumFromInt',
  '@intFromEnum',
  '@errorName',
  '@embedFile',
  '@max',
  '@min',
  '@memcpy',
  '@memset',
  '@addWithOverflow',
  '@subWithOverflow',
  '@mulWithOverflow',
  '@shlWithOverflow',
  // Common stdlib helpers that would otherwise overwhelm the call graph.
  'panic',
  'assert',
  'print',
  'debugPrint',
]);

export const zigProvider = defineLanguage({
  id: SupportedLanguages.Zig,
  extensions: ['.zig'],
  treeSitterQueries: ZIG_QUERIES,
  typeConfig: zigConfig,
  exportChecker: zigExportChecker,
  importResolver: createImportResolver(zigImportConfig),
  namedBindingExtractor: extractZigNamedBindings,
  // 'first-wins' is the default; Zig has no inheritance so MRO is irrelevant.
  callExtractor: createCallExtractor(zigCallConfig),
  fieldExtractor: zigFieldExtractor,
  methodExtractor: createMethodExtractor(zigMethodConfig),
  variableExtractor: createVariableExtractor(zigVariableConfig),
  classExtractor: createClassExtractor(zigClassConfig),
  heritageExtractor: createHeritageExtractor(SupportedLanguages.Zig),
  builtInNames: BUILT_INS,
});
