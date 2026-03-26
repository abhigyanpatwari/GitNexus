/**
 * Dart Language Provider
 *
 * Dart traits:
 *   - importSemantics: 'wildcard' (Dart imports bring everything public into scope)
 *   - exportChecker: public if no leading underscore
 *   - Dart SDK imports (dart:*) and external packages are skipped
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as dartConfig } from '../type-extractors/dart.js';
import { dartExportChecker } from '../export-detection.js';
import { resolveDartImport } from '../import-resolvers/dart.js';
import { DART_QUERIES } from '../tree-sitter-queries.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'setState', 'mounted', 'debugPrint',
  'runApp', 'showDialog', 'showModalBottomSheet',
  'Navigator', 'push', 'pushNamed', 'pushReplacement', 'pop', 'maybePop',
  'ScaffoldMessenger', 'showSnackBar',
  'deactivate', 'reassemble', 'debugDumpApp', 'debugDumpRenderTree',
  'then', 'catchError', 'whenComplete', 'listen',
]);

export const dartProvider = defineLanguage({
  id: SupportedLanguages.Dart,
  extensions: ['.dart'],
  treeSitterQueries: DART_QUERIES,
  typeConfig: dartConfig,
  exportChecker: dartExportChecker,
  importResolver: resolveDartImport,
  importSemantics: 'wildcard',
  builtInNames: BUILT_INS,
});
