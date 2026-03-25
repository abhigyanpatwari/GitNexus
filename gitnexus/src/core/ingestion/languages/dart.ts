/**
 * Dart/Flutter Language Provider
 *
 * Dart uses bare relative imports (no extension required in import path)
 * and package: imports resolved via pubspec.yaml. SDK dart: imports are
 * external and skipped.
 *
 * Key Dart traits:
 *   - importSemantics: 'wildcard' (Dart imports entire library scope)
 *   - Visibility: underscore prefix = library-private, everything else public
 *   - Heritage: EXTENDS by default, IMPLEMENTS for interfaces
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as dartTypeConfig } from '../type-extractors/dart.js';
import { dartExportChecker } from '../export-detection.js';
import { resolveDartImport } from '../import-resolvers/dart.js';
import { DART_QUERIES } from '../tree-sitter-queries.js';

export const dartProvider = defineLanguage({
  id: SupportedLanguages.Dart,
  extensions: ['.dart'],
  treeSitterQueries: DART_QUERIES,
  typeConfig: dartTypeConfig,
  exportChecker: dartExportChecker,
  importResolver: resolveDartImport,
  importSemantics: 'wildcard',
});
