import type { Capture } from 'gitnexus-shared';
import { resolveTsJsContainerTypeOwner } from '../../class-extractors/configs/typescript-javascript.js';
import { syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

/** Keep named-expression scope declarations on the graph's owner/member IDs. */
export function synthesizeTsJsClassIdentity(
  captures: Record<string, Capture>,
  nodes: Record<string, SyntaxNode>,
): void {
  const type =
    nodes['@declaration.class'] ?? nodes['@declaration.interface'] ?? nodes['@declaration.enum'];
  if (type !== undefined) {
    const owner = resolveTsJsContainerTypeOwner(type, '');
    if (owner !== null) {
      captures['@declaration.qualified_name'] = syntheticCapture(
        '@declaration.qualified_name',
        type,
        owner.name,
      );
    }
    return;
  }
  const member =
    nodes['@declaration.method'] ??
    nodes['@declaration.constructor'] ??
    nodes['@declaration.property'];
  const name = nodes['@declaration.name'];
  if (member === undefined || name === undefined) return;
  for (let parent = member.parent; parent !== null; parent = parent.parent) {
    // Object members and executable-body locals belong to their own scope.
    if (
      parent.type === 'object' ||
      parent.type === 'object_type' ||
      parent.type === 'statement_block'
    )
      return;
    if (
      parent.type === 'class' ||
      parent.type === 'class_declaration' ||
      parent.type === 'abstract_class_declaration' ||
      parent.type === 'interface_declaration'
    ) {
      const owner = resolveTsJsContainerTypeOwner(parent, '');
      if (owner !== null) {
        captures['@declaration.qualified_name'] = syntheticCapture(
          '@declaration.qualified_name',
          member,
          `${owner.name}.${name.text}`,
        );
      }
      return;
    }
  }
}
