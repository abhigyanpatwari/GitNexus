/**
 * C# language provider.
 *
 * C# uses named imports (using directives), modifier-based export detection,
 * and an implements-split MRO strategy for multiple interface implementation.
 * Interface names follow the I-prefix convention (e.g., IDisposable).
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as csharpConfig } from '../type-extractors/csharp.js';
import { csharpExportChecker } from '../export-detection.js';
import { resolveCSharpImport } from '../import-resolvers/csharp.js';
import { extractCSharpNamedBindings } from '../named-bindings/csharp.js';
import { CSHARP_QUERIES } from '../tree-sitter-queries.js';

export const csharpProvider = defineLanguage({
  id: SupportedLanguages.CSharp,
  extensions: ['.cs'],
  treeSitterQueries: CSHARP_QUERIES,
  typeConfig: csharpConfig,
  exportChecker: csharpExportChecker,
  importResolver: resolveCSharpImport,
  namedBindingExtractor: extractCSharpNamedBindings,
  interfaceNamePattern: /^I[A-Z]/,
  mroStrategy: 'implements-split',
});
