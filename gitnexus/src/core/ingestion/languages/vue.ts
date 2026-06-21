/**
 * Vue language provider.
 *
 * Vue SFCs are preprocessed by extracting the <script> / <script setup>
 * block content, which is then parsed as TypeScript. This provider reuses
 * nearly all TypeScript infrastructure — queries, type config, field
 * extraction, and named binding extraction.
 *
 * Export detection for <script setup> is handled directly in the parse
 * worker (all top-level bindings are implicitly exported). The export
 * checker here is used as fallback for non-setup <script> blocks.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { vueClassConfig } from '../class-extractors/configs/typescript-javascript.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as typescriptConfig } from '../type-extractors/typescript.js';
import { tsExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { vueImportConfig } from '../import-resolvers/configs/typescript-javascript.js';
import { TYPESCRIPT_QUERIES } from '../tree-sitter-queries.js';
import { typescriptFieldExtractor } from '../field-extractors/typescript.js';
import { BUILT_INS as TS_BUILT_INS } from './typescript.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { typescriptVariableConfig } from '../variable-extractors/configs/typescript-javascript.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { typescriptCallConfig } from '../call-extractors/configs/typescript-javascript.js';
import {
  interpretTsImport,
  interpretTsTypeBinding,
  tsBindingScopeFor,
  tsImportOwningScope,
  tsReceiverBinding,
  typescriptMergeBindings,
  typescriptArityCompatibility,
  resolveTsImportTarget,
} from './typescript/index.js';
import { emitVueScopeCaptures } from './vue/captures.js';
import { createTypeScriptCfgVisitor } from '../cfg/visitors/typescript.js';

const VUE_SPECIFIC_BUILT_INS = [
  'ref',
  'reactive',
  'computed',
  'watch',
  'watchEffect',
  'onMounted',
  'onUnmounted',
  'onBeforeMount',
  'onBeforeUnmount',
  'onUpdated',
  'onBeforeUpdate',
  'nextTick',
  'defineProps',
  'defineEmits',
  'defineExpose',
  'defineOptions',
  'defineSlots',
  'defineModel',
  'withDefaults',
  'toRef',
  'toRefs',
  'unref',
  'isRef',
  'shallowRef',
  'triggerRef',
  'provide',
  'inject',
  'useSlots',
  'useAttrs',
] as const;

const VUE_BUILT_INS: ReadonlySet<string> = new Set([...TS_BUILT_INS, ...VUE_SPECIFIC_BUILT_INS]);

const vueClassExtractor = createClassExtractor(vueClassConfig);

export const vueProvider = defineLanguage({
  id: SupportedLanguages.Vue,
  extensions: ['.vue'],
  entryPointPatterns: [],
  astFrameworkPatterns: [],
  treeSitterQueries: TYPESCRIPT_QUERIES,
  typeConfig: typescriptConfig,
  exportChecker: tsExportChecker,
  importResolver: createImportResolver(vueImportConfig),
  callExtractor: createCallExtractor(typescriptCallConfig),
  fieldExtractor: typescriptFieldExtractor,
  variableExtractor: createVariableExtractor(typescriptVariableConfig),
  classExtractor: vueClassExtractor,
  builtInNames: VUE_BUILT_INS,
  // Vue SFC <script> blocks are extracted and parsed with the TypeScript
  // grammar (parse-worker GRAMMAR_BY_LANGUAGE[Vue] = TypeScript.typescript),
  // so the TS CFG visitor builds CFGs for the script's functions verbatim —
  // no Vue-specific visitor needed (#2195).
  cfgVisitor: createTypeScriptCfgVisitor(),
  // Scope-resolution pipeline hooks (RFC #909 Ring 3)
  emitScopeCaptures: emitVueScopeCaptures,
  interpretImport: interpretTsImport,
  interpretTypeBinding: interpretTsTypeBinding,
  bindingScopeFor: tsBindingScopeFor,
  importOwningScope: tsImportOwningScope,
  receiverBinding: tsReceiverBinding,
  mergeBindings: (_scope, bindings) => typescriptMergeBindings(bindings),
  arityCompatibility: typescriptArityCompatibility,
  resolveImportTarget: resolveTsImportTarget,
});
