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
import { defineLanguage } from '../language-provider.js';
import { typeConfig as typescriptConfig } from '../type-extractors/typescript.js';
import { tsExportChecker } from '../export-detection.js';
import { resolveVueImport } from '../import-resolvers/vue.js';
import { extractTsNamedBindings } from '../named-bindings/typescript.js';
import { TYPESCRIPT_QUERIES } from '../tree-sitter-queries.js';
import { typescriptFieldExtractor } from '../field-extractors/typescript.js';

const VUE_BUILT_INS: ReadonlySet<string> = new Set([
  // Standard JS/TS built-ins
  'console',
  'log',
  'warn',
  'error',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'parseInt',
  'parseFloat',
  'JSON',
  'parse',
  'stringify',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Map',
  'Set',
  'Promise',
  'Math',
  'Date',
  'Error',
  'fetch',
  // Vue composition API
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
]);

export const vueProvider = defineLanguage({
  id: SupportedLanguages.Vue,
  extensions: ['.vue'],
  treeSitterQueries: TYPESCRIPT_QUERIES,
  typeConfig: typescriptConfig,
  exportChecker: tsExportChecker,
  importResolver: resolveVueImport,
  namedBindingExtractor: extractTsNamedBindings,
  fieldExtractor: typescriptFieldExtractor,
  builtInNames: VUE_BUILT_INS,
});
