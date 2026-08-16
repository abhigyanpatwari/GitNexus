import type { SyntaxNode } from '../../utils/ast-helpers.js';

/** Direct protocols written on one Objective-C protocol declaration. */
export function objectiveCAdoptedProtocolNames(node: SyntaxNode): readonly string[] {
  if (node.type !== 'protocol_declaration') return [];
  const names = new Set<string>();
  for (const list of node.namedChildren.filter(
    (child) => child.type === 'parameterized_arguments' || child.type === 'protocol_reference_list',
  )) {
    for (const protocol of list.descendantsOfType(['identifier', 'type_identifier'])) {
      const name = protocol.text.trim();
      if (name.length > 0) names.add(name);
    }
  }
  return [...names];
}

/**
 * Completeness fact consumed by protocol dispatch. `[]` is intentional: it
 * distinguishes a declaration with no parents from stale/incomplete metadata.
 */
export function objectiveCProtocolParentsAnnotation(node: SyntaxNode): string | undefined {
  return node.type === 'protocol_declaration'
    ? `objc:protocol-parents:${JSON.stringify(objectiveCAdoptedProtocolNames(node))}`
    : undefined;
}
