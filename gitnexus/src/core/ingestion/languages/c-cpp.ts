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
import { createClassExtractor } from '../class-extractors/generic.js';
import { cClassConfig, cppClassConfig } from '../class-extractors/configs/c-cpp.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as cCppConfig } from '../type-extractors/c-cpp.js';
import { cCppExportChecker } from '../export-detection.js';
import { resolveCImport, resolveCppImport } from '../import-resolvers/standard.js';
import { C_QUERIES, CPP_QUERIES } from '../tree-sitter-queries.js';

/**
 * Node types for standard function declarations that need C/C++ declarator handling.
 * Used by cCppExtractFunctionName to determine how to extract the function name.
 */
const FUNCTION_DECLARATION_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'async_function_declaration',
  'generator_function_declaration',
  'function_item',
]);
import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NodeLabel } from 'gitnexus-shared';
import type { LanguageProvider } from '../language-provider.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import {
  cConfig as cFieldConfig,
  cppConfig as cppFieldConfig,
} from '../field-extractors/configs/c-cpp.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { cMethodConfig, cppMethodConfig } from '../method-extractors/configs/c-cpp.js';

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

const cClassExtractor = createClassExtractor(cClassConfig);

const cppClassExtractor = createClassExtractor(cppClassConfig);

/**
 * C/C++ function name extraction — unwraps pointer_declarator / reference_declarator /
 * function_declarator / qualified_identifier chains to find the actual function name.
 * Handles field_identifier (method inside class body) and parenthesized_declarator.
 */
const cCppExtractFunctionName = (
  node: SyntaxNode,
): { funcName: string | null; label: NodeLabel } | null => {
  if (!FUNCTION_DECLARATION_TYPES.has(node.type)) return null;

  let funcName: string | null = null;
  let label: NodeLabel = 'Function';

  // C/C++: function_definition -> [pointer_declarator ->] function_declarator -> qualified_identifier/identifier
  // Unwrap pointer_declarator / reference_declarator wrappers to reach function_declarator
  let declarator = node.childForFieldName?.('declarator');
  if (!declarator) {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c?.type === 'function_declarator') {
        declarator = c;
        break;
      }
    }
  }
  while (
    declarator &&
    (declarator.type === 'pointer_declarator' || declarator.type === 'reference_declarator')
  ) {
    let nextDeclarator = declarator.childForFieldName?.('declarator');
    if (!nextDeclarator) {
      for (let i = 0; i < declarator.childCount; i++) {
        const c = declarator.child(i);
        if (
          c?.type === 'function_declarator' ||
          c?.type === 'pointer_declarator' ||
          c?.type === 'reference_declarator'
        ) {
          nextDeclarator = c;
          break;
        }
      }
    }
    declarator = nextDeclarator;
  }
  if (declarator) {
    let innerDeclarator = declarator.childForFieldName?.('declarator');
    if (!innerDeclarator) {
      for (let i = 0; i < declarator.childCount; i++) {
        const c = declarator.child(i);
        if (
          c?.type === 'qualified_identifier' ||
          c?.type === 'identifier' ||
          c?.type === 'field_identifier' ||
          c?.type === 'parenthesized_declarator'
        ) {
          innerDeclarator = c;
          break;
        }
      }
    }

    if (innerDeclarator?.type === 'qualified_identifier') {
      let nameNode = innerDeclarator.childForFieldName?.('name');
      if (!nameNode) {
        for (let i = 0; i < innerDeclarator.childCount; i++) {
          const c = innerDeclarator.child(i);
          if (c?.type === 'identifier') {
            nameNode = c;
            break;
          }
        }
      }
      if (nameNode?.text) {
        funcName = nameNode.text;
        label = 'Method';
      }
    } else if (
      innerDeclarator?.type === 'identifier' ||
      innerDeclarator?.type === 'field_identifier'
    ) {
      // field_identifier is used for method names inside C++ class bodies
      funcName = innerDeclarator.text;
      if (innerDeclarator.type === 'field_identifier') label = 'Method';
    } else if (innerDeclarator?.type === 'parenthesized_declarator') {
      let nestedId: SyntaxNode | null = null;
      for (let i = 0; i < innerDeclarator.childCount; i++) {
        const c = innerDeclarator.child(i);
        if (c?.type === 'qualified_identifier' || c?.type === 'identifier') {
          nestedId = c;
          break;
        }
      }
      if (nestedId?.type === 'qualified_identifier') {
        let nameNode = nestedId.childForFieldName?.('name');
        if (!nameNode) {
          for (let i = 0; i < nestedId.childCount; i++) {
            const c = nestedId.child(i);
            if (c?.type === 'identifier') {
              nameNode = c;
              break;
            }
          }
        }
        if (nameNode?.text) {
          funcName = nameNode.text;
          label = 'Method';
        }
      } else if (nestedId?.type === 'identifier') {
        funcName = nestedId.text;
      }
    }
  }

  // Fallback for other node types in FUNCTION_DECLARATION_TYPES (e.g. function_item for Rust in C++ tree)
  if (!funcName) {
    let nameNode = node.childForFieldName?.('name');
    if (!nameNode) {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (
          c?.type === 'identifier' ||
          c?.type === 'property_identifier' ||
          c?.type === 'simple_identifier'
        ) {
          nameNode = c;
          break;
        }
      }
    }
    funcName = nameNode?.text ?? null;
  }

  return { funcName, label };
};

/** Check if a C/C++ function_definition is inside a class or struct body.
 *  Used by cppLabelOverride to skip duplicate function captures
 *  that are already covered by definition.method queries. */
function isCppInsideClassOrStruct(functionNode: SyntaxNode): boolean {
  let ancestor: SyntaxNode | null = functionNode?.parent ?? null;
  while (ancestor) {
    if (ancestor.type === 'class_specifier' || ancestor.type === 'struct_specifier') return true;
    ancestor = ancestor.parent;
  }
  return false;
}

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
  importSemantics: 'wildcard-transitive',
  fieldExtractor: createFieldExtractor(cFieldConfig),
  methodExtractor: createMethodExtractor({
    ...cMethodConfig,
    extractFunctionName: cCppExtractFunctionName,
  }),
  classExtractor: cClassExtractor,
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
  importSemantics: 'wildcard-transitive',
  mroStrategy: 'leftmost-base',
  fieldExtractor: createFieldExtractor(cppFieldConfig),
  methodExtractor: createMethodExtractor({
    ...cppMethodConfig,
    extractFunctionName: cCppExtractFunctionName,
  }),
  classExtractor: cppClassExtractor,
  labelOverride: cppLabelOverride,
  builtInNames: C_BUILT_INS,
});
