/**
 * Rust Language Provider
 *
 * Assembles all Rust-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Rust traits:
 *   - importSemantics: 'named' (Rust has use X::{a, b})
 *   - mroStrategy: 'qualified-syntax' (Rust uses trait qualification, not MRO)
 *   - namedBindingExtractor: present (use X::{a, b} extracts named bindings)
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfigs } from '../type-extractors/index.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers, namedBindingExtractors } from '../import-resolution.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';

export const rustProvider = defineLanguage({
  id: SupportedLanguages.Rust,
  extensions: ['.rs'],
  treeSitterQueries: LANGUAGE_QUERIES[SupportedLanguages.Rust],
  typeConfig: typeConfigs[SupportedLanguages.Rust],
  exportChecker: exportCheckers[SupportedLanguages.Rust],
  importResolver: importResolvers[SupportedLanguages.Rust],
  callRouter: callRouters[SupportedLanguages.Rust],
  namedBindingExtractor: namedBindingExtractors[SupportedLanguages.Rust],
  mroStrategy: 'qualified-syntax',
});
