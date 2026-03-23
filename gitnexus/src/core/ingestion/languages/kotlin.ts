/**
 * Kotlin language provider.
 *
 * Kotlin uses named imports with JVM wildcard/member resolution and
 * Java-interop fallback. Default visibility is public (no modifier needed).
 * Heritage uses EXTENDS by default with implements-split MRO for
 * multiple interface implementation.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { createLanguageProvider } from '../language-provider.js';
import { typeConfigs } from '../type-extractors/index.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers, namedBindingExtractors } from '../import-resolution.js';
import { appendKotlinWildcard } from '../resolvers/jvm.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';
import { isKotlinClassMethod } from '../ast-helpers.js';

export const kotlinProvider = createLanguageProvider({
  id: SupportedLanguages.Kotlin,
  extensions: ['.kt', '.kts'],
  treeSitterQueries: LANGUAGE_QUERIES[SupportedLanguages.Kotlin],
  typeConfig: typeConfigs[SupportedLanguages.Kotlin],
  exportChecker: exportCheckers[SupportedLanguages.Kotlin],
  importResolver: importResolvers[SupportedLanguages.Kotlin],
  callRouter: callRouters[SupportedLanguages.Kotlin],
  namedBindingExtractor: namedBindingExtractors[SupportedLanguages.Kotlin],
  importPathPreprocessor: (cleaned, importNode) => appendKotlinWildcard(cleaned, importNode),
  mroStrategy: 'implements-split',
  labelOverride: (functionNode: any, defaultLabel: string): string | null => {
    if (defaultLabel !== 'Function') return defaultLabel;
    if (isKotlinClassMethod(functionNode)) return 'Method';
    return defaultLabel;
  },
});
