/**
 * C# language provider.
 *
 * C# uses named imports (using directives), modifier-based export detection,
 * and an implements-split MRO strategy for multiple interface implementation.
 * Interface names follow the I-prefix convention (e.g., IDisposable).
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { createLanguageProvider } from '../language-provider.js';
import { typeConfigs } from '../type-extractors/index.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers, namedBindingExtractors } from '../import-resolution.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';

export const csharpProvider = createLanguageProvider({
  id: SupportedLanguages.CSharp,
  extensions: ['.cs'],
  treeSitterQueries: LANGUAGE_QUERIES[SupportedLanguages.CSharp],
  typeConfig: typeConfigs[SupportedLanguages.CSharp],
  exportChecker: exportCheckers[SupportedLanguages.CSharp],
  importResolver: importResolvers[SupportedLanguages.CSharp],
  callRouter: callRouters[SupportedLanguages.CSharp],
  namedBindingExtractor: namedBindingExtractors[SupportedLanguages.CSharp],
  interfaceNamePattern: /^I[A-Z]/,
  mroStrategy: 'implements-split',
});
