/**
 * Swift Language Provider
 *
 * Assembles all Swift-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Swift traits:
 *   - importSemantics: 'wildcard' (Swift imports entire modules)
 *   - heritageDefaultEdge: 'IMPLEMENTS' (protocols are more common than class inheritance)
 *   - implicitImportWirer: all files in the same SPM target see each other
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as swiftConfig } from '../type-extractors/swift.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers } from '../import-resolution.js';
import { SWIFT_QUERIES } from '../tree-sitter-queries.js';
import { wireSwiftImplicitImports } from '../helpers/swift.js';

export const swiftProvider = defineLanguage({
  id: SupportedLanguages.Swift,
  extensions: ['.swift'],
  treeSitterQueries: SWIFT_QUERIES,
  typeConfig: swiftConfig,
  exportChecker: exportCheckers[SupportedLanguages.Swift],
  importResolver: importResolvers[SupportedLanguages.Swift],
  callRouter: callRouters[SupportedLanguages.Swift],
  importSemantics: 'wildcard',
  heritageDefaultEdge: 'IMPLEMENTS',
  implicitImportWirer: wireSwiftImplicitImports,
});
