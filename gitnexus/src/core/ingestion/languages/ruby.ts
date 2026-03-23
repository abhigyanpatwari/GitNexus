/**
 * Ruby language provider.
 *
 * Ruby uses wildcard import semantics (require/require_relative bring
 * everything into scope). Ruby has SPECIAL call routing via routeRubyCall
 * to handle require, include/extend (heritage), and attr_accessor/
 * attr_reader/attr_writer (property definitions) as call expressions.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { createLanguageProvider } from '../language-provider.js';
import { typeConfigs } from '../type-extractors/index.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers, namedBindingExtractors } from '../import-resolution.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';

export const rubyProvider = createLanguageProvider({
  id: SupportedLanguages.Ruby,
  extensions: ['.rb', '.rake', '.gemspec'],
  treeSitterQueries: LANGUAGE_QUERIES[SupportedLanguages.Ruby],
  typeConfig: typeConfigs[SupportedLanguages.Ruby],
  exportChecker: exportCheckers[SupportedLanguages.Ruby],
  importResolver: importResolvers[SupportedLanguages.Ruby],
  callRouter: callRouters[SupportedLanguages.Ruby],
  namedBindingExtractor: namedBindingExtractors[SupportedLanguages.Ruby],
  importSemantics: 'wildcard',
});
