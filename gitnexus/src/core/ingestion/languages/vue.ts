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
import { extractTsNamedBindings } from '../named-bindings/typescript.js';
import { TYPESCRIPT_QUERIES } from '../tree-sitter-queries.js';
import { typescriptFieldExtractor } from '../field-extractors/typescript.js';
import { BUILT_INS as TS_BUILT_INS } from './typescript.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { typescriptVariableConfig } from '../variable-extractors/configs/typescript-javascript.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { typescriptCallConfig } from '../call-extractors/configs/typescript-javascript.js';

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
  treeSitterQueries: TYPESCRIPT_QUERIES,
  typeConfig: typescriptConfig,
  exportChecker: tsExportChecker,
  importResolver: createImportResolver(vueImportConfig),
  namedBindingExtractor: extractTsNamedBindings,
  callExtractor: createCallExtractor(typescriptCallConfig),
  fieldExtractor: typescriptFieldExtractor,
  variableExtractor: createVariableExtractor(typescriptVariableConfig),
  classExtractor: vueClassExtractor,
  builtInNames: VUE_BUILT_INS,
});
