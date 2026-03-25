/**
 * C and C++ language providers.
 *
 * Both languages use wildcard import semantics (headers expose all symbols
 * via #include). Neither language has named binding extraction.
 *
 * C uses 'first-wins' MRO (no inheritance). C++ uses 'leftmost-base' MRO
 * for its left-to-right multiple inheritance resolution order.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as cCppConfig } from '../type-extractors/c-cpp.js';
import { cCppExportChecker } from '../export-detection.js';
import { resolveCImport, resolveCppImport } from '../import-resolvers/standard.js';
import { C_QUERIES, CPP_QUERIES } from '../tree-sitter-queries.js';

import { isCppInsideClassOrStruct } from '../utils/ast-helpers.js';
import type { LanguageProvider } from '../language-provider.js';

/** Label override shared by C and C++: skip function_definition captures inside class/struct
 *  bodies (they're duplicates of definition.method captures). */
const cppLabelOverride: NonNullable<LanguageProvider['labelOverride']> = (functionNode, defaultLabel) => {
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
  labelOverride: cppLabelOverride,
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
  labelOverride: cppLabelOverride,
});
