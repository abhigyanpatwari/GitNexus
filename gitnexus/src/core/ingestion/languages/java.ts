/**
 * Java language provider.
 *
 * Java uses named imports, JVM wildcard/member import resolution,
 * and a 'public' modifier-based export checker. Heritage uses
 * EXTENDS by default with implements-split MRO for multiple
 * interface implementation.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { javaTypeConfig } from '../type-extractors/jvm.js';
import { javaExportChecker } from '../export-detection.js';
import { resolveJavaImport } from '../import-resolvers/jvm.js';
import { extractJavaNamedBindings } from '../named-bindings/java.js';
import { JAVA_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { javaConfig } from '../field-extractors/configs/jvm.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { javaMethodConfig } from '../method-extractors/configs/jvm.js';

function isSpringRouteFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.endsWith('Controller.java') ||
    normalized.includes('/controller/') ||
    normalized.includes('/controllers/')
  );
}

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
  fieldExtractor: createFieldExtractor(javaConfig),
  methodExtractor: createMethodExtractor(javaMethodConfig),
  isRouteFile: isSpringRouteFile,
});
