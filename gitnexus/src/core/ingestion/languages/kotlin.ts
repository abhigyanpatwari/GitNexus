/**
 * Kotlin language provider.
 *
 * Kotlin uses named imports with JVM wildcard/member resolution and
 * Java-interop fallback. Default visibility is public (no modifier needed).
 * Heritage uses EXTENDS by default with implements-split MRO for
 * multiple interface implementation.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { kotlinTypeConfig } from '../type-extractors/jvm.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers } from '../import-resolution.js';
import { extractKotlinNamedBindings } from '../named-binding-extraction.js';
import { appendKotlinWildcard } from '../resolvers/jvm.js';
import { KOTLIN_QUERIES } from '../tree-sitter-queries.js';
import { isKotlinClassMethod } from '../ast-helpers.js';

export const kotlinProvider = defineLanguage({
  id: SupportedLanguages.Kotlin,
  extensions: ['.kt', '.kts'],
  treeSitterQueries: KOTLIN_QUERIES,
  typeConfig: kotlinTypeConfig,
  exportChecker: exportCheckers[SupportedLanguages.Kotlin],
  importResolver: importResolvers[SupportedLanguages.Kotlin],
  callRouter: callRouters[SupportedLanguages.Kotlin],
  namedBindingExtractor: extractKotlinNamedBindings,
  importPathPreprocessor: appendKotlinWildcard,
  mroStrategy: 'implements-split',
  labelOverride: (functionNode, defaultLabel) => {
    if (defaultLabel !== 'Function') return defaultLabel;
    if (isKotlinClassMethod(functionNode)) return 'Method';
    return defaultLabel;
  },
});
