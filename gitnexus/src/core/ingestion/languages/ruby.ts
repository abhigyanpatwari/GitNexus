/**
 * Ruby language provider.
 *
 * Ruby uses wildcard import semantics (require/require_relative bring
 * everything into scope). Ruby has SPECIAL call routing via routeRubyCall
 * to handle require, include/extend (heritage), and attr_accessor/
 * attr_reader/attr_writer (property definitions) as call expressions.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { NodeLabel } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { rubyClassConfig } from '../class-extractors/configs/ruby.js';
import { defineLanguage } from '../language-provider.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { typeConfig as rubyConfig } from '../type-extractors/ruby.js';
import { routeRubyCall } from '../call-routing.js';
import { rubyExportChecker } from '../export-detection.js';
import { resolveRubyImport } from '../import-resolvers/ruby.js';
import { RUBY_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { rubyConfig as rubyFieldConfig } from '../field-extractors/configs/ruby.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { rubyMethodConfig } from '../method-extractors/configs/ruby.js';

/** Ruby method/singleton_method: extract name from 'name' field, label as Method. */
const rubyExtractFunctionName = (
  node: SyntaxNode,
): { funcName: string | null; label: NodeLabel } | null => {
  if (node.type !== 'method' && node.type !== 'singleton_method') return null;

  let nameNode = node.childForFieldName?.('name');
  if (!nameNode) {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c?.type === 'identifier') {
        nameNode = c;
        break;
      }
    }
  }
  return { funcName: nameNode?.text ?? null, label: 'Method' };
};

const BUILT_INS: ReadonlySet<string> = new Set([
  'puts',
  'p',
  'pp',
  'raise',
  'fail',
  'require',
  'require_relative',
  'load',
  'autoload',
  'include',
  'extend',
  'prepend',
  'attr_accessor',
  'attr_reader',
  'attr_writer',
  'public',
  'private',
  'protected',
  'module_function',
  'lambda',
  'proc',
  'block_given?',
  'nil?',
  'is_a?',
  'kind_of?',
  'instance_of?',
  'respond_to?',
  'freeze',
  'frozen?',
  'dup',
  'tap',
  'yield_self',
  'each',
  'select',
  'reject',
  'detect',
  'collect',
  'inject',
  'flat_map',
  'each_with_object',
  'each_with_index',
  'any?',
  'all?',
  'none?',
  'count',
  'first',
  'last',
  'sort_by',
  'min_by',
  'max_by',
  'group_by',
  'partition',
  'compact',
  'flatten',
  'uniq',
]);

export const rubyProvider = defineLanguage({
  id: SupportedLanguages.Ruby,
  extensions: ['.rb', '.rake', '.gemspec'],
  treeSitterQueries: RUBY_QUERIES,
  typeConfig: rubyConfig,
  exportChecker: rubyExportChecker,
  importResolver: resolveRubyImport,
  callRouter: routeRubyCall,
  importSemantics: 'wildcard-leaf',
  resolveEnclosingOwner(node) {
    // Ruby singleton_class (class << self) should resolve to the enclosing
    // class or module for owner/container resolution (HAS_METHOD edges, class IDs).
    if (node.type === 'singleton_class') {
      let ancestor = node.parent;
      while (ancestor) {
        if (ancestor.type === 'class' || ancestor.type === 'module') {
          return ancestor;
        }
        ancestor = ancestor.parent;
      }
      return null; // no enclosing class/module — skip
    }
    return node; // use as-is for all other container types
  },
  fieldExtractor: createFieldExtractor(rubyFieldConfig),
  methodExtractor: createMethodExtractor({
    ...rubyMethodConfig,
    extractFunctionName: rubyExtractFunctionName,
  }),
  classExtractor: createClassExtractor(rubyClassConfig),
  builtInNames: BUILT_INS,
});
