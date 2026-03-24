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
import { defineLanguage } from '../language-provider.js';
import { typeConfig as pythonConfig } from '../type-extractors/python.js';
import { noRouting } from '../call-routing.js';
import { pythonExportChecker } from '../export-detection.js';
import { resolvePythonImport } from '../import-resolution.js';
import { extractPythonNamedBindings } from '../named-binding-extraction.js';
import { PYTHON_QUERIES } from '../tree-sitter-queries.js';

export const pythonProvider = defineLanguage({
  id: SupportedLanguages.Python,
  extensions: ['.py'],
  treeSitterQueries: PYTHON_QUERIES,
  typeConfig: pythonConfig,
  exportChecker: pythonExportChecker,
  importResolver: resolvePythonImport,
  callRouter: noRouting,
  namedBindingExtractor: extractPythonNamedBindings,
  importSemantics: 'namespace',
  mroStrategy: 'c3',
});
