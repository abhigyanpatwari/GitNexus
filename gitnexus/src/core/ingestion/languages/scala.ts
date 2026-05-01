/**
 * Scala Language Provider
 *
 * Assembles all Scala-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Scala traits:
 *   - importSemantics: 'named' (explicit imports like Java/Kotlin)
 *   - JVM package resolution reused from Java
 *   - class/trait/object as first-class constructs
 *   - Methods are function_definition inside template_body
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { scalaClassConfig } from '../class-extractors/configs/scala.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as scalaConfig } from '../type-extractors/scala.js';
import { scalaExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { scalaImportConfig } from '../import-resolvers/configs/scala.js';
import { SCALA_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { scalaFieldConfig } from '../field-extractors/configs/scala.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { scalaMethodConfig } from '../method-extractors/configs/scala.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { scalaVariableConfig } from '../variable-extractors/configs/scala.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { scalaCallConfig } from '../call-extractors/configs/scala.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';
import { scalaHeritageConfig } from '../heritage-extractors/configs/scala.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'println',
  'print',
  'require',
  'assert',
  'assume',
  'throw',
  'sys',
  'classOf',
  'isInstanceOf',
  'asInstanceOf',
  'toString',
  'hashCode',
  'equals',
  'getClass',
  'synchronized',
  'wait',
  'notify',
  'notifyAll',
]);

export const scalaProvider = defineLanguage({
  id: SupportedLanguages.Scala,
  extensions: ['.scala', '.sc'],
  treeSitterQueries: SCALA_QUERIES,
  typeConfig: scalaConfig,
  exportChecker: scalaExportChecker,
  importResolver: createImportResolver(scalaImportConfig),
  importSemantics: 'named',
  mroStrategy: 'implements-split',
  callExtractor: createCallExtractor(scalaCallConfig),
  fieldExtractor: createFieldExtractor(scalaFieldConfig),
  methodExtractor: createMethodExtractor(scalaMethodConfig),
  variableExtractor: createVariableExtractor(scalaVariableConfig),
  classExtractor: createClassExtractor(scalaClassConfig),
  heritageExtractor: createHeritageExtractor(scalaHeritageConfig),
  builtInNames: BUILT_INS,
});
