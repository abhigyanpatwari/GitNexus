/**
 * Python Language Provider
 *
 * Assembles all Python-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Python traits:
 *   - importSemantics: 'namespace' (Python uses namespace imports, not wildcard)
 *   - mroStrategy: 'c3' (Python C3 linearization for multiple inheritance)
 *   - namedBindingExtractor: present (from X import Y)
 *   - callRouter: noRouting (no call-routing needed)
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { createLanguageProvider } from '../language-provider.js';
import { typeConfigs } from '../type-extractors/index.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers, namedBindingExtractors } from '../import-resolution.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';

export const pythonProvider = createLanguageProvider({
  id: SupportedLanguages.Python,
  extensions: ['.py'],
  treeSitterQueries: LANGUAGE_QUERIES[SupportedLanguages.Python],
  typeConfig: typeConfigs[SupportedLanguages.Python],
  exportChecker: exportCheckers[SupportedLanguages.Python],
  importResolver: importResolvers[SupportedLanguages.Python],
  callRouter: callRouters[SupportedLanguages.Python],
  namedBindingExtractor: namedBindingExtractors[SupportedLanguages.Python],
  importSemantics: 'namespace',
  mroStrategy: 'c3',
});
