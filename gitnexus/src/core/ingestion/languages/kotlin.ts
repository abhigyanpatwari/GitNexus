/**
 * Kotlin language provider.
 *
 * Kotlin uses named imports with JVM wildcard/member resolution and
 * Java-interop fallback. Default visibility is public (no modifier needed).
 * Heritage uses EXTENDS by default with implements-split MRO for
 * multiple interface implementation.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { kotlinTypeConfig } from '../type-extractors/jvm.js';
import { kotlinExportChecker } from '../export-detection.js';
import { resolveKotlinImport } from '../import-resolvers/jvm.js';
import { extractKotlinNamedBindings } from '../named-bindings/kotlin.js';
import { appendKotlinWildcard } from '../import-resolvers/jvm.js';
import { KOTLIN_QUERIES } from '../tree-sitter-queries.js';
import { isKotlinClassMethod } from '../utils/ast-helpers.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { kotlinConfig } from '../field-extractors/configs/jvm.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'println',
  'print',
  'readLine',
  'require',
  'requireNotNull',
  'check',
  'assert',
  'lazy',
  'error',
  'listOf',
  'mapOf',
  'setOf',
  'mutableListOf',
  'mutableMapOf',
  'mutableSetOf',
  'arrayOf',
  'sequenceOf',
  'also',
  'apply',
  'run',
  'with',
  'takeIf',
  'takeUnless',
  'TODO',
  'buildString',
  'buildList',
  'buildMap',
  'buildSet',
  'repeat',
  'synchronized',
  'launch',
  'async',
  'runBlocking',
  'withContext',
  'coroutineScope',
  'supervisorScope',
  'delay',
  'flow',
  'flowOf',
  'collect',
  'emit',
  'onEach',
  'catch',
  'buffer',
  'conflate',
  'distinctUntilChanged',
  'flatMapLatest',
  'flatMapMerge',
  'combine',
  'stateIn',
  'shareIn',
  'launchIn',
  'to',
  'until',
  'downTo',
  'step',
]);

export const kotlinProvider = defineLanguage({
  id: SupportedLanguages.Kotlin,
  extensions: ['.kt', '.kts'],
  treeSitterQueries: KOTLIN_QUERIES,
  typeConfig: kotlinTypeConfig,
  exportChecker: kotlinExportChecker,
  importResolver: resolveKotlinImport,
  namedBindingExtractor: extractKotlinNamedBindings,
  importPathPreprocessor: appendKotlinWildcard,
  mroStrategy: 'implements-split',
  fieldExtractor: createFieldExtractor(kotlinConfig),
  builtInNames: BUILT_INS,
  labelOverride: (functionNode, defaultLabel) => {
    if (defaultLabel !== 'Function') return defaultLabel;
    if (isKotlinClassMethod(functionNode)) return 'Method';
    return defaultLabel;
  },
});
