import type { NodeLabel } from 'gitnexus-shared';
import type { ClassExtractionConfig, ClassExtractor } from '../class-types.js';
import type { LanguageProvider } from '../language-provider.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { createClassExtractor } from './generic.js';

// Like qualifiedNodeId, but only for type names declared more than once in the
// file, so languages with a namespace/package prefix keep their existing ids.
export function createCollisionQualifiedClassExtractor(config: ClassExtractionConfig): {
  readonly classExtractor: ClassExtractor;
  readonly resolveContainerTypeOwner: NonNullable<LanguageProvider['resolveContainerTypeOwner']>;
} {
  const base = createClassExtractor({ ...config, qualifiedNodeId: false });
  const collisionsByTree = new WeakMap<SyntaxNode['tree'], ReadonlySet<string>>();

  const collidingNames = (node: SyntaxNode): ReadonlySet<string> | undefined => {
    const tree = node.tree;
    if (!tree) return undefined;
    const cached = collisionsByTree.get(tree);
    if (cached) return cached;
    const seen = new Set<string>();
    const collisions = new Set<string>();
    for (const declaration of tree.rootNode.descendantsOfType(config.typeDeclarationNodes)) {
      const name = base.extract(declaration)?.name;
      if (name === undefined) continue;
      if (seen.has(name)) collisions.add(name);
      seen.add(name);
    }
    collisionsByTree.set(tree, collisions);
    return collisions;
  };

  const extract: ClassExtractor['extract'] = (node, fallback) => {
    const symbol = base.extract(node, fallback);
    if (symbol !== null && collidingNames(node)?.has(symbol.name)) {
      symbol.qualifiedNodeId = true;
    }
    return symbol;
  };

  const classExtractor: ClassExtractor = { ...base, extract };

  const resolveContainerTypeOwner = (
    node: SyntaxNode,
  ): { readonly name: string; readonly label: NodeLabel } | null => {
    if (!base.isTypeDeclaration(node)) return null;
    const symbol = extract(node);
    return symbol?.qualifiedNodeId === true
      ? { name: symbol.qualifiedName, label: symbol.type }
      : null;
  };

  return { classExtractor, resolveContainerTypeOwner };
}
