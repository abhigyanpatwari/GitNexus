/**
 * Java language provider.
 *
 * Java uses named imports, JVM wildcard/member import resolution,
 * and a 'public' modifier-based export checker. Heritage uses
 * EXTENDS by default with implements-split MRO for multiple
 * interface implementation.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { createLanguageProvider } from '../language-provider.js';
import { typeConfigs } from '../type-extractors/index.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers, namedBindingExtractors } from '../import-resolution.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';

export const javaProvider = createLanguageProvider({
  id: SupportedLanguages.Java,
  extensions: ['.java'],
  treeSitterQueries: LANGUAGE_QUERIES[SupportedLanguages.Java],
  typeConfig: typeConfigs[SupportedLanguages.Java],
  exportChecker: exportCheckers[SupportedLanguages.Java],
  importResolver: importResolvers[SupportedLanguages.Java],
  callRouter: callRouters[SupportedLanguages.Java],
  namedBindingExtractor: namedBindingExtractors[SupportedLanguages.Java],
  interfaceNamePattern: /^I[A-Z]/,
  mroStrategy: 'implements-split',
});
