/**
 * Go Language Provider
 *
 * Assembles all Go-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Go traits:
 *   - importSemantics: 'wildcard' (Go imports entire packages)
 *   - callRouter: present (Go method calls may need routing)
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as goConfig } from '../type-extractors/go.js';
import { goExportChecker } from '../export-detection.js';
import { resolveGoImport } from '../import-resolvers/go.js';
import { GO_QUERIES } from '../tree-sitter-queries.js';

export const goProvider = defineLanguage({
  id: SupportedLanguages.Go,
  extensions: ['.go'],
  treeSitterQueries: GO_QUERIES,
  typeConfig: goConfig,
  exportChecker: goExportChecker,
  importResolver: resolveGoImport,
  importSemantics: 'wildcard',
});
