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
import { typeConfigs } from '../type-extractors/index.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers } from '../import-resolution.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';

import { isCppInsideClassOrStruct } from '../ast-helpers.js';
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
  treeSitterQueries: LANGUAGE_QUERIES[SupportedLanguages.C],
  typeConfig: typeConfigs[SupportedLanguages.C],
  exportChecker: exportCheckers[SupportedLanguages.C],
  importResolver: importResolvers[SupportedLanguages.C],
  callRouter: callRouters[SupportedLanguages.C],
  importSemantics: 'wildcard',
  labelOverride: cppLabelOverride,
});

export const cppProvider = defineLanguage({
  id: SupportedLanguages.CPlusPlus,
  extensions: ['.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh'],
  treeSitterQueries: LANGUAGE_QUERIES[SupportedLanguages.CPlusPlus],
  typeConfig: typeConfigs[SupportedLanguages.CPlusPlus],
  exportChecker: exportCheckers[SupportedLanguages.CPlusPlus],
  importResolver: importResolvers[SupportedLanguages.CPlusPlus],
  callRouter: callRouters[SupportedLanguages.CPlusPlus],
  importSemantics: 'wildcard',
  mroStrategy: 'leftmost-base',
  labelOverride: cppLabelOverride,
});
