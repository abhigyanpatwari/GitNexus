/**
 * TypeScript and JavaScript language providers.
 *
 * Both languages share the same type extraction config (typescriptConfig),
 * export checker (tsExportChecker), call router (noRouting), and named
 * binding extractor (extractTsNamedBindings). They differ in file extensions,
 * tree-sitter queries (TypeScript grammar has interface/type nodes), and
 * language ID.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as typescriptConfig } from '../type-extractors/typescript.js';
import { noRouting } from '../call-routing.js';
import { tsExportChecker } from '../export-detection.js';
import { resolveTypescriptImport, resolveJavascriptImport } from '../import-resolution.js';
import { extractTsNamedBindings } from '../named-binding-extraction.js';
import { TYPESCRIPT_QUERIES, JAVASCRIPT_QUERIES } from '../tree-sitter-queries.js';

export const typescriptProvider = defineLanguage({
  id: SupportedLanguages.TypeScript,
  extensions: ['.ts', '.tsx'],
  treeSitterQueries: TYPESCRIPT_QUERIES,
  typeConfig: typescriptConfig,
  exportChecker: tsExportChecker,
  importResolver: resolveTypescriptImport,
  callRouter: noRouting,
  namedBindingExtractor: extractTsNamedBindings,
});

export const javascriptProvider = defineLanguage({
  id: SupportedLanguages.JavaScript,
  extensions: ['.js', '.jsx'],
  treeSitterQueries: JAVASCRIPT_QUERIES,
  typeConfig: typescriptConfig,
  exportChecker: tsExportChecker,
  importResolver: resolveJavascriptImport,
  callRouter: noRouting,
  namedBindingExtractor: extractTsNamedBindings,
});
