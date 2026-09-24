// gitnexus/src/core/ingestion/class-extractors/configs/ruby.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassLikeNodeLabel, ClassExtractionConfig } from '../../class-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

export type RubyFactoryType = ClassLikeNodeLabel | 'Trait';

/**
 * Return the type synthesized by Ruby's allowlisted class factories.
 *
 * `Const = Struct.new(...) do ... end` and its siblings all use the same
 * assignment/call/block grammar shape as arbitrary block-taking calls, so
 * the receiver and method must both be checked before treating the block as a
 * type container.
 */
export const rubyFactoryType = (node: SyntaxNode): RubyFactoryType | undefined => {
  if (node.type !== 'do_block' && node.type !== 'block') return undefined;
  const call = node.parent;
  if (call?.type !== 'call' || call.childForFieldName?.('block') !== node) return undefined;

  const receiver = call.childForFieldName?.('receiver')?.text;
  const method = call.childForFieldName?.('method')?.text;
  if (method !== 'new' && method !== 'define') return undefined;

  if (receiver === 'Struct' && method === 'new') return 'Struct';
  if (receiver === 'Data' && method === 'define') return 'Class';
  if (receiver === 'Class' && method === 'new') return 'Class';
  if (receiver === 'Module' && method === 'new') return 'Trait';
  return undefined;
};

export const rubyFactoryBindingName = (node: SyntaxNode): string | undefined => {
  if (rubyFactoryType(node) === undefined) return undefined;
  const assignment = node.parent?.parent;
  if (
    assignment?.type !== 'assignment' ||
    assignment.childForFieldName?.('right') !== node.parent
  ) {
    return undefined;
  }
  const left = assignment.childForFieldName?.('left');
  return left?.type === 'constant' ? left.text : undefined;
};

export const rubyClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Ruby,
  typeDeclarationNodes: ['class', 'do_block'],
  ancestorScopeNodeTypes: ['module', 'class'],
  // #1978: key nested-type nodes by their fully-qualified path (Outer.Inner) so
  // same-tail classes nested under different modules stay distinct.
  qualifiedNodeId: true,
  extractName: (node) => rubyFactoryBindingName(node),
  extractType: (node) => {
    const type = rubyFactoryType(node);
    return type === 'Trait' ? undefined : type;
  },
};
