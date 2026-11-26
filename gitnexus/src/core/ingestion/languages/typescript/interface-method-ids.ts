import type { MethodExtractor, MethodExtractorContext, MethodInfo } from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { resolveTsJsContainerTypeOwner } from '../../class-extractors/configs/typescript-javascript.js';

type Collisions = ReadonlyMap<number, ReadonlySet<string>>;
const collisionsByTree = new WeakMap<SyntaxNode['tree'], Collisions>();

function signatureKey(method: MethodInfo): string {
  return method.parameters.length + ':' + method.name;
}

function mergedMethodCollisions(
  owner: SyntaxNode,
  context: MethodExtractorContext,
  extractor: MethodExtractor,
): ReadonlySet<string> | undefined {
  if (owner.type !== 'interface_declaration') return;
  let collisions = collisionsByTree.get(owner.tree);
  if (!collisions) {
    const groups = new Map<string, SyntaxNode[]>();
    for (const declaration of owner.tree.rootNode.descendantsOfType('interface_declaration')) {
      const name = resolveTsJsContainerTypeOwner(declaration, context.filePath)?.name;
      if (!name) continue;
      const group = groups.get(name);
      if (group) group.push(declaration);
      else groups.set(name, [declaration]);
    }
    const byOwner = new Map<number, Set<string>>();
    for (const group of groups.values()) {
      const seen = new Set<string>();
      const repeated = new Set<string>();
      for (const declaration of group) {
        const keys = extractor.extract(declaration, context)?.methods.map(signatureKey) ?? [];
        for (const key of keys) {
          if (seen.has(key)) repeated.add(key);
          seen.add(key);
        }
      }
      if (repeated.size) for (const declaration of group) byOwner.set(declaration.id, repeated);
    }
    collisions = byOwner;
    collisionsByTree.set(owner.tree, collisions);
  }
  return collisions.get(owner.id);
}

function distinguishDeclaration(method: MethodInfo, collisions?: ReadonlySet<string>): void {
  if (collisions?.has(signatureKey(method))) {
    method.graphIdSuffix = `#${method.parameters.length}@${method.line}:${method.column}`;
  }
}

/** Methods in separate declarations of the same interface share one graph owner. */
export function withMergedInterfaceMethodIds(extractor: MethodExtractor): MethodExtractor {
  return {
    ...extractor,
    extract(node, context) {
      const result = extractor.extract(node, context);
      if (result?.methods.length) {
        const collisions = mergedMethodCollisions(node, context, extractor);
        if (collisions)
          for (const method of result.methods) distinguishDeclaration(method, collisions);
      }
      return result;
    },
    extractFromNode(node, context) {
      const result = extractor.extractFromNode?.(node, context) ?? null;
      const owner = node.parent?.parent;
      if (result && owner)
        distinguishDeclaration(result, mergedMethodCollisions(owner, context, extractor));
      return result;
    },
  };
}
