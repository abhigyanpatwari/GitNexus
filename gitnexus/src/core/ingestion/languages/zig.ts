/**
 * Zig Language Provider
 *
 * Zig traits:
 *   - importSemantics: 'namespace' (`const std = @import("std")`)
 *   - exportChecker: `pub` and `export` declarations are externally visible
 *   - namedBindingExtractor: module aliases are captured from `const foo = @import(...)`
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as zigConfig } from '../type-extractors/zig.js';
import { zigExportChecker } from '../export-detection.js';
import { resolveStandard } from '../import-resolvers/standard.js';
import { extractZigNamedBindings } from '../named-bindings/zig.js';
import { ZIG_QUERIES } from '../tree-sitter-queries.js';
import { ZigFieldExtractor } from '../field-extractors/zig.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'alloc',
  'append',
  'dupe',
  'dupeZ',
  'expect',
  'expectEqual',
  'expectEqualStrings',
  'expectError',
  'free',
  'parseFloat',
  'parseInt',
  'print',
]);

export const zigProvider = defineLanguage({
  id: SupportedLanguages.Zig,
  extensions: ['.zig'],
  treeSitterQueries: ZIG_QUERIES,
  typeConfig: zigConfig,
  fieldExtractor: new ZigFieldExtractor(),
  exportChecker: zigExportChecker,
  importResolver: (raw, filePath, ctx) => resolveStandard(raw, filePath, ctx, SupportedLanguages.Zig),
  namedBindingExtractor: extractZigNamedBindings,
  importSemantics: 'namespace',
  builtInNames: BUILT_INS,
});
