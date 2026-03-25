/**
 * Java language provider.
 *
 * Java uses named imports, JVM wildcard/member import resolution,
 * and a 'public' modifier-based export checker. Heritage uses
 * EXTENDS by default with implements-split MRO for multiple
 * interface implementation.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { javaTypeConfig } from '../type-extractors/jvm.js';
import { javaExportChecker } from '../export-detection.js';
import { resolveJavaImport } from '../import-resolvers/jvm.js';
import { extractJavaNamedBindings } from '../named-bindings/java.js';
import { JAVA_QUERIES } from '../tree-sitter-queries.js';

export const javaProvider = defineLanguage({
  id: SupportedLanguages.Java,
  extensions: ['.java'],
  treeSitterQueries: JAVA_QUERIES,
  typeConfig: javaTypeConfig,
  exportChecker: javaExportChecker,
  importResolver: resolveJavaImport,
  namedBindingExtractor: extractJavaNamedBindings,
  interfaceNamePattern: /^I[A-Z]/,
  mroStrategy: 'implements-split',
});
