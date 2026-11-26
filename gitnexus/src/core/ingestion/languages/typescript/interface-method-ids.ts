import type { MethodExtractor, MethodExtractorContext, MethodInfo } from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { resolveTsJsContainerTypeOwner } from '../../class-extractors/configs/typescript-javascript.js';
import { arityForIdFromInfo } from '../../utils/method-props.js';

type Collisions = ReadonlyMap<number, ReadonlySet<string>>;
const collisionsByTree = new WeakMap<SyntaxNode['tree'], Collisions>();
const classCollisionsByTree = new WeakMap<SyntaxNode['tree'], Map<number, ReadonlySet<string>>>();

function signatureKey(method: MethodInfo): string {
  return (arityForIdFromInfo(method) ?? 'rest') + ':' + method.name;
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
      const name = resolveTsJsContainerTypeOwner(declaration)?.name;
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

function methodCollisions(
  owner: SyntaxNode,
  context: MethodExtractorContext,
  extractor: MethodExtractor,
  methods?: readonly MethodInfo[],
) {
  if (owner.type === 'interface_declaration')
    return mergedMethodCollisions(owner, context, extractor);
  if (!['class', 'class_declaration', 'abstract_class_declaration'].includes(owner.type)) return;
  let owners = classCollisionsByTree.get(owner.tree);
  if (!owners) {
    owners = new Map();
    classCollisionsByTree.set(owner.tree, owners);
  }
  const previous = owners.get(owner.id);
  if (previous) return previous;
  const members = methods ?? extractor.extract(owner, context)?.methods ?? [];
  const statics = new Set(members.filter((method) => method.isStatic).map(signatureKey));
  const collisions = new Set<string>();
  if (statics.size) {
    for (const method of members) {
      if (method.isStatic) continue;
      const key = signatureKey(method);
      if (statics.has(key)) collisions.add(key);
    }
  }
  owners.set(owner.id, collisions);
  return collisions;
}

/** Methods in separate declarations of the same interface share one graph owner. */
export function withMergedInterfaceMethodIds(extractor: MethodExtractor): MethodExtractor {
  return {
    ...extractor,
    extract(node, context) {
      const result = extractor.extract(node, context);
      if (result?.methods.length) {
        const collisions = methodCollisions(node, context, extractor, result.methods);
        if (collisions?.size)
          for (const method of result.methods) distinguishDeclaration(method, collisions);
      }
      return result;
    },
    extractFromNode(node, context) {
      const result = extractor.extractFromNode?.(node, context) ?? null;
      if (
        result &&
        ['method_signature', 'method_definition', 'abstract_method_signature'].includes(node.type)
      ) {
        const owner = node.parent?.parent;
        if (owner) distinguishDeclaration(result, methodCollisions(owner, context, extractor));
      }
      return result;
    },
  };
}
