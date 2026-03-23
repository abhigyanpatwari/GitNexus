/**
 * TypeScript and JavaScript language providers.
 *
 * Both languages share the same type extraction config (typescriptConfig),
 * export checker (tsExportChecker), call router (noRouting), and named
 * binding extractor (extractTsNamedBindings). They differ in file extensions,
 * tree-sitter queries (TypeScript grammar has interface/type nodes), and
 * language ID.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { createLanguageProvider } from '../language-provider.js';
import { typeConfigs } from '../type-extractors/index.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers, namedBindingExtractors } from '../import-resolution.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';

export const typescriptProvider = createLanguageProvider({
  id: SupportedLanguages.TypeScript,
  extensions: ['.ts', '.tsx'],
  treeSitterQueries: LANGUAGE_QUERIES[SupportedLanguages.TypeScript],
  typeConfig: typeConfigs[SupportedLanguages.TypeScript],
  exportChecker: exportCheckers[SupportedLanguages.TypeScript],
  importResolver: importResolvers[SupportedLanguages.TypeScript],
  callRouter: callRouters[SupportedLanguages.TypeScript],
  namedBindingExtractor: namedBindingExtractors[SupportedLanguages.TypeScript],
});

export const javascriptProvider = createLanguageProvider({
  id: SupportedLanguages.JavaScript,
  extensions: ['.js', '.jsx'],
  treeSitterQueries: LANGUAGE_QUERIES[SupportedLanguages.JavaScript],
  typeConfig: typeConfigs[SupportedLanguages.JavaScript],
  exportChecker: exportCheckers[SupportedLanguages.JavaScript],
  importResolver: importResolvers[SupportedLanguages.JavaScript],
  callRouter: callRouters[SupportedLanguages.JavaScript],
  namedBindingExtractor: namedBindingExtractors[SupportedLanguages.JavaScript],
});
