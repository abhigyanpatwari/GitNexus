/**
 * Ruby language provider.
 *
 * Ruby uses wildcard import semantics (require/require_relative bring
 * everything into scope). Ruby has SPECIAL call routing via routeRubyCall
 * to handle require, include/extend (heritage), and attr_accessor/
 * attr_reader/attr_writer (property definitions) as call expressions.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as rubyConfig } from '../type-extractors/ruby.js';
import { routeRubyCall } from '../call-routing.js';
import { rubyExportChecker } from '../export-detection.js';
import { resolveRubyImport } from '../import-resolvers/ruby.js';
import { RUBY_QUERIES } from '../tree-sitter-queries.js';

export const rubyProvider = defineLanguage({
  id: SupportedLanguages.Ruby,
  extensions: ['.rb', '.rake', '.gemspec'],
  treeSitterQueries: RUBY_QUERIES,
  typeConfig: rubyConfig,
  exportChecker: rubyExportChecker,
  importResolver: resolveRubyImport,
  callRouter: routeRubyCall,
  importSemantics: 'wildcard',
});
