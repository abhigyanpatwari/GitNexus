import type { Capture } from 'gitnexus-shared';
import {
  anonymousDefaultClassKeyword,
  resolveTsJsContainerTypeOwner,
} from '../../class-extractors/configs/typescript-javascript.js';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

function enclosingMemberOwner(member: SyntaxNode) {
  for (let parent = member.parent; parent !== null; parent = parent.parent) {
    // Object members and executable-body locals belong to their own scope.
    if (
      parent.type === 'object' ||
      parent.type === 'object_type' ||
      parent.type === 'statement_block'
    )
      return null;
    if (
      parent.type === 'class' ||
      parent.type === 'class_declaration' ||
      parent.type === 'abstract_class_declaration' ||
      parent.type === 'interface_declaration'
    )
      return resolveTsJsContainerTypeOwner(parent);
  }
  return null;
}

/** Keep class scope declarations on the graph's owner/member IDs. Reject an anonymous
 * parenthesized class candidate unless its export supplies the `default` binding. */
export function synthesizeTsJsClassIdentity(
  captures: Record<string, Capture>,
  nodes: Record<string, SyntaxNode>,
): boolean {
  const type =
    nodes['@declaration.class'] ?? nodes['@declaration.interface'] ?? nodes['@declaration.enum'];
  if (type !== undefined) {
    if (!nodes['@declaration.name']) {
      const keyword = anonymousDefaultClassKeyword(type);
      if (!keyword) return false;
      nodes['@declaration.name'] = keyword;
      captures['@declaration.name'] = nodeToCapture('@declaration.name', keyword);
    }
    const owner = resolveTsJsContainerTypeOwner(type);
    if (owner !== null) {
      captures['@declaration.qualified_name'] = syntheticCapture(
        '@declaration.qualified_name',
        type,
        owner.name,
      );
    }
    return true;
  }
  const member =
    nodes['@declaration.method'] ??
    nodes['@declaration.constructor'] ??
    nodes['@declaration.property'];
  const name = captures['@declaration.name'];
  if (member === undefined || name === undefined) return true;
  const owner = enclosingMemberOwner(member);
  if (owner !== null) {
    captures['@declaration.qualified_name'] = syntheticCapture(
      '@declaration.qualified_name',
      member,
      `${owner.name}.${name.text}`,
    );
  }
  return true;
}
