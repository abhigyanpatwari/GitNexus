import type { ParameterInfo } from '../method-types.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

type DeclarationFact = string | undefined | readonly Readonly<ParameterInfo>[];

/** Share a pure, node-only fact across structure and scope extraction.
 * Trees are immutable during ingestion. Native node IDs survive different JS
 * wrappers; tree ownership keeps IDs from colliding across files or reparses.
 * Values must contain no AST nodes. File/owner-dependent callbacks stay uncached.
 * Providers may identify an equivalent declaration inside the same tree when
 * one consumer sees a syntax wrapper and another sees its inner declaration.
 */
export function memoizeDeclarationFact<T extends DeclarationFact>(
  extract: (node: SyntaxNode) => T,
  declaration?: (node: SyntaxNode) => SyntaxNode | null,
): (node: SyntaxNode) => T {
  const trees = new WeakMap<object, Map<number, T>>();
  return (node) => {
    const tree = node.tree;
    const id = node.id;
    if (!tree || typeof id !== 'number') return extract(node);
    let facts = trees.get(tree);
    if (facts?.has(id)) return facts.get(id)!;
    const declarationId = declaration?.(node)?.id ?? id;
    if (declarationId !== id && facts?.has(declarationId)) {
      const fact = facts.get(declarationId)!;
      facts.set(id, fact);
      return fact;
    }
    const fact = extract(node);
    if (!facts) {
      facts = new Map();
      trees.set(tree, facts);
    }
    facts.set(id, fact);
    if (declarationId !== id) facts.set(declarationId, fact);
    return fact;
  };
}
