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
import { createLanguageProvider } from '../language-provider.js';
import { typeConfigs } from '../type-extractors/index.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers } from '../import-resolution.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';

/** Walk up the AST to check if a function_definition is inside a class/struct body.
 *  Shared by both C and C++ providers — C structs cannot have methods but the
 *  check is harmless and keeps the two providers symmetric. */
function cppLabelOverride(functionNode: any, defaultLabel: string): string | null {
  if (defaultLabel !== 'Function') return defaultLabel;
  let ancestor = functionNode?.parent;
  while (ancestor) {
    if (ancestor.type === 'class_specifier' || ancestor.type === 'struct_specifier') return null;
    ancestor = ancestor.parent;
  }
  return defaultLabel;
}

export const cProvider = createLanguageProvider({
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

export const cppProvider = createLanguageProvider({
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
