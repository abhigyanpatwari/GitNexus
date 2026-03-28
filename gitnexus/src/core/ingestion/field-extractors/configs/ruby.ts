// gitnexus/src/core/ingestion/field-extractors/configs/ruby.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Collect all field names declared by an `attr_accessor`, `attr_reader`, or
 * `attr_writer` call node.  A single call may list multiple symbols:
 *   attr_accessor :foo, :bar, :baz
 */
function extractAttrNames(node: SyntaxNode): string[] {
  const method = node.childForFieldName('method');
  if (!method) return [];
  const methodName = method.text;
  if (
    methodName !== 'attr_accessor' &&
    methodName !== 'attr_reader' &&
    methodName !== 'attr_writer'
  ) {
    return [];
  }
  const args = node.childForFieldName('arguments');
  if (!args) return [];
  const names: string[] = [];
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg) continue;
    // simple_symbol text is :name — strip the leading colon
    const text = arg.text;
    names.push(text.startsWith(':') ? text.slice(1) : text);
  }
  return names;
}

/**
 * Ruby field extraction config.
 *
 * Ruby is unusual: there are no field declarations in the traditional sense.
 * Fields are instance variables (@var) created by assignment, or declared
 * via attr_accessor / attr_reader / attr_writer calls.
 *
 * We detect:
 * - `call` nodes for attr_accessor / attr_reader / attr_writer
 *   (their arguments are symbol names → field names)
 *
 * For simplicity we focus on attr_* calls in the class body.
 * Instance variable assignments (self.x = ...) would require deeper analysis.
 */
export const rubyConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Ruby,
  typeDeclarationNodes: ['class'],
  fieldNodeTypes: ['call'],
  bodyNodeTypes: ['body_statement'],
  defaultVisibility: 'public',

  extractName(node) {
    // Returns the first symbol name for interface compatibility.
    // Use extractNames to obtain all names from a single attr_* call.
    return extractAttrNames(node)[0];
  },

  extractNames(node) {
    return extractAttrNames(node);
  },

  extractType(_node) {
    // Ruby is dynamically typed; no type annotations in standard Ruby
    return undefined;
  },

  extractVisibility(_node) {
    // attr_accessor/attr_writer fields are effectively public
    // attr_reader fields are read-only from outside but still public
    return 'public';
  },

  isStatic(_node) {
    return false;
  },

  isReadonly(node) {
    const method = node.childForFieldName('method');
    return method?.text === 'attr_reader';
  },
};
