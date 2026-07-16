/**
 * Kotlin language provider.
 *
 * Kotlin uses named imports with JVM wildcard/member resolution and
 * Java-interop fallback. Default visibility is public (no modifier needed).
 * Heritage uses EXTENDS by default with implements-split MRO for
 * multiple interface implementation.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { kotlinClassConfig } from '../class-extractors/configs/jvm.js';
import { defineLanguage } from '../language-provider.js';
import { createLeadingDocDescriptionExtractor } from '../utils/ast-helpers.js';
import { assertCloneable } from '../workers/clone-safety.js';
import { kotlinTypeConfig } from '../type-extractors/jvm.js';
import { kotlinExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { kotlinImportConfig } from '../import-resolvers/configs/jvm.js';
import { appendKotlinWildcard } from '../import-resolvers/jvm.js';
import { KOTLIN_QUERIES } from '../tree-sitter-queries.js';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { kotlinCallConfig } from '../call-extractors/configs/jvm.js';
import { createKotlinCfgVisitor } from '../cfg/visitors/kotlin.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { kotlinConfig } from '../field-extractors/configs/jvm.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { kotlinMethodConfig } from '../method-extractors/configs/jvm.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { kotlinVariableConfig } from '../variable-extractors/configs/jvm.js';
import {
  collectKotlinCaptureSideChannel,
  emitKotlinScopeCaptures,
  interpretKotlinImport,
  interpretKotlinTypeBinding,
  kotlinArityCompatibility,
  kotlinBindingScopeFor,
  kotlinImportOwningScope,
  kotlinMergeBindings,
  kotlinReceiverBinding,
} from './kotlin/index.js';

/** Check if a Kotlin function_declaration capture is inside a class_body (i.e., a method).
 *  Kotlin grammar uses function_declaration for both top-level functions and class methods.
 *  Returns true when the captured definition node has a class_body ancestor. */
function isKotlinClassMethod(
  captureNode: { parent?: SyntaxNode | null } | null | undefined,
): boolean {
  let ancestor = captureNode?.parent;
  while (ancestor) {
    if (ancestor.type === 'class_body') return true;
    ancestor = ancestor.parent;
  }
  return false;
}

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
  entryPointPatterns: [
    /^on(Create|Start|Resume|Pause|Stop|Destroy)$/,
    /^do[A-Z]/,
    /^create[A-Z]/,
    /^build[A-Z]/,
    /ViewModel$/,
    /^module$/,
    /Service$/,
  ],
  astFrameworkPatterns: [
    {
      framework: 'spring-kotlin',
      entryPointMultiplier: 3.2,
      reason: 'spring-kotlin-annotation',
      patterns: [
        '@RestController',
        '@Controller',
        '@GetMapping',
        '@PostMapping',
        '@RequestMapping',
      ],
    },
    {
      framework: 'jaxrs',
      entryPointMultiplier: 3.0,
      reason: 'jaxrs-annotation',
      patterns: ['@Path', '@GET', '@POST', '@PUT', '@DELETE'],
    },
    {
      framework: 'ktor',
      entryPointMultiplier: 2.8,
      reason: 'ktor-routing',
      patterns: ['routing', 'embeddedServer', 'Application.module'],
    },
    {
      framework: 'android-kotlin',
      entryPointMultiplier: 2.5,
      reason: 'android-annotation',
      patterns: ['@AndroidEntryPoint', 'AppCompatActivity', 'Fragment('],
    },
  ] satisfies AstFrameworkPatternConfig[],
  treeSitterQueries: KOTLIN_QUERIES,
  typeConfig: kotlinTypeConfig,
  exportChecker: kotlinExportChecker,
  importResolver: createImportResolver(kotlinImportConfig),
  importPathPreprocessor: appendKotlinWildcard,
  mroStrategy: 'implements-split',
  callExtractor: createCallExtractor(kotlinCallConfig),
  fieldExtractor: createFieldExtractor(kotlinConfig),
  methodExtractor: createMethodExtractor(kotlinMethodConfig),
  variableExtractor: createVariableExtractor(kotlinVariableConfig),
  classExtractor: createClassExtractor(kotlinClassConfig),
  builtInNames: BUILT_INS,

  // ── KDoc → description (issue #2270) ──
  descriptionExtractor: createLeadingDocDescriptionExtractor(),

  labelOverride: (functionNode, defaultLabel) => {
    if (defaultLabel !== 'Function') return defaultLabel;
    if (isKotlinClassMethod(functionNode)) return 'Method';
    return defaultLabel;
  },

  // ── RFC #909 Ring 3: scope-based resolution hooks ──
  emitScopeCaptures: emitKotlinScopeCaptures,
  // ── #2195 PDG layer: Kotlin CFG visitor (vendored grammar) ──
  cfgVisitor: createKotlinCfgVisitor(),
  // Worker-side: snapshot the module-level companion-scope marks
  // `emitKotlinScopeCaptures` just populated for this file (`markCompanionScope`
  // → `companionScopesByFile`) into plain data on `ParsedFile.captureSideChannel`,
  // so the main thread can restore them via `applyCaptureSideChannel` WITHOUT a
  // re-parse (#1983). Without this, companion/static dispatch emits no CALLS
  // edges on the worker path. See `kotlin/capture-side-channel.ts`.
  // `assertCloneable` is a runtime identity; it makes a future non-serializable
  // value in the side-channel payload a compile error here, at the source, rather
  // than a DataCloneError at the worker boundary (#2143).
  collectCaptureSideChannel: (filePath) =>
    assertCloneable(collectKotlinCaptureSideChannel(filePath)),
  interpretImport: interpretKotlinImport,
  interpretTypeBinding: interpretKotlinTypeBinding,
  bindingScopeFor: kotlinBindingScopeFor,
  importOwningScope: kotlinImportOwningScope,
  mergeBindings: (_scope, bindings) => kotlinMergeBindings(bindings),
  receiverBinding: kotlinReceiverBinding,
  arityCompatibility: kotlinArityCompatibility,
});
