/**
 * C and C++ language providers.
 *
 * Both languages use wildcard import semantics (headers expose all symbols
 * via #include). Neither language has named binding extraction.
 *
 * C uses 'first-wins' MRO (no inheritance). C++ uses 'leftmost-base' MRO
 * for its left-to-right multiple inheritance resolution order.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as cCppConfig } from '../type-extractors/c-cpp.js';
import { cCppExportChecker } from '../export-detection.js';
import { resolveCImport, resolveCppImport } from '../import-resolvers/standard.js';
import { C_QUERIES, CPP_QUERIES } from '../tree-sitter-queries.js';

import { isCppInsideClassOrStruct } from '../utils/ast-helpers.js';
import type { LanguageProvider } from '../language-provider.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import {
  cConfig as cFieldConfig,
  cppConfig as cppFieldConfig,
} from '../field-extractors/configs/c-cpp.js';

const C_BUILT_INS: ReadonlySet<string> = new Set([
  'printf',
  'fprintf',
  'sprintf',
  'snprintf',
  'vprintf',
  'vfprintf',
  'vsprintf',
  'vsnprintf',
  'scanf',
  'fscanf',
  'sscanf',
  'malloc',
  'calloc',
  'realloc',
  'free',
  'memcpy',
  'memmove',
  'memset',
  'memcmp',
  'strlen',
  'strcpy',
  'strncpy',
  'strcat',
  'strncat',
  'strcmp',
  'strncmp',
  'strstr',
  'strchr',
  'strrchr',
  'atoi',
  'atol',
  'atof',
  'strtol',
  'strtoul',
  'strtoll',
  'strtoull',
  'strtod',
  'sizeof',
  'offsetof',
  'typeof',
  'assert',
  'abort',
  'exit',
  '_exit',
  'fopen',
  'fclose',
  'fread',
  'fwrite',
  'fseek',
  'ftell',
  'rewind',
  'fflush',
  'fgets',
  'fputs',
  'likely',
  'unlikely',
  'BUG',
  'BUG_ON',
  'WARN',
  'WARN_ON',
  'WARN_ONCE',
  'IS_ERR',
  'PTR_ERR',
  'ERR_PTR',
  'IS_ERR_OR_NULL',
  'ARRAY_SIZE',
  'container_of',
  'list_for_each_entry',
  'list_for_each_entry_safe',
  'min',
  'max',
  'clamp',
  'abs',
  'swap',
  'pr_info',
  'pr_warn',
  'pr_err',
  'pr_debug',
  'pr_notice',
  'pr_crit',
  'pr_emerg',
  'printk',
  'dev_info',
  'dev_warn',
  'dev_err',
  'dev_dbg',
  'GFP_KERNEL',
  'GFP_ATOMIC',
  'spin_lock',
  'spin_unlock',
  'spin_lock_irqsave',
  'spin_unlock_irqrestore',
  'mutex_lock',
  'mutex_unlock',
  'mutex_init',
  'kfree',
  'kmalloc',
  'kzalloc',
  'kcalloc',
  'krealloc',
  'kvmalloc',
  'kvfree',
  'get',
  'put',
]);

/** Label override shared by C and C++: skip function_definition captures inside class/struct
 *  bodies (they're duplicates of definition.method captures). */
const cppLabelOverride: NonNullable<LanguageProvider['labelOverride']> = (
  functionNode,
  defaultLabel,
) => {
  if (defaultLabel !== 'Function') return defaultLabel;
  return isCppInsideClassOrStruct(functionNode) ? null : defaultLabel;
};

export const cProvider = defineLanguage({
  id: SupportedLanguages.C,
  extensions: ['.c'],
  treeSitterQueries: C_QUERIES,
  typeConfig: cCppConfig,
  exportChecker: cCppExportChecker,
  importResolver: resolveCImport,
  importSemantics: 'wildcard',
  fieldExtractor: createFieldExtractor(cFieldConfig),
  labelOverride: cppLabelOverride,
  builtInNames: C_BUILT_INS,
});

export const cppProvider = defineLanguage({
  id: SupportedLanguages.CPlusPlus,
  extensions: ['.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh'],
  treeSitterQueries: CPP_QUERIES,
  typeConfig: cCppConfig,
  exportChecker: cCppExportChecker,
  importResolver: resolveCppImport,
  importSemantics: 'wildcard',
  mroStrategy: 'leftmost-base',
  fieldExtractor: createFieldExtractor(cppFieldConfig),
  labelOverride: cppLabelOverride,
  builtInNames: C_BUILT_INS,
});
