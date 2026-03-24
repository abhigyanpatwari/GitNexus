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
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers } from '../import-resolution.js';
import { extractCsharpNamedBindings } from '../named-binding-extraction.js';
import { CSHARP_QUERIES } from '../tree-sitter-queries.js';

export const csharpProvider = defineLanguage({
  id: SupportedLanguages.CSharp,
  extensions: ['.cs'],
  treeSitterQueries: CSHARP_QUERIES,
  typeConfig: csharpConfig,
  exportChecker: exportCheckers[SupportedLanguages.CSharp],
  importResolver: importResolvers[SupportedLanguages.CSharp],
  callRouter: callRouters[SupportedLanguages.CSharp],
  namedBindingExtractor: extractCsharpNamedBindings,
  interfaceNamePattern: /^I[A-Z]/,
  mroStrategy: 'implements-split',
});
