import { javaClassConfig } from '../../class-extractors/configs/jvm.js';
import { createClassExtractor } from '../../class-extractors/generic.js';
import type { ClassExtractor } from '../../class-types.js';
import {
  synthesizeJavaTypeIdentity,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';

const declaredTypes = createClassExtractor(javaClassConfig);
const collisionsByTree = new WeakMap<SyntaxNode['tree'], ReadonlySet<string>>();
const anonymousClassHosts = new Set(['object_creation_expression', 'enum_constant']);
const namedTypeNodes = javaClassConfig.typeDeclarationNodes.filter(
  (kind) => !anonymousClassHosts.has(kind),
);
const collisionCandidateNodes = [...namedTypeNodes, 'class_body'];

/** A legal source name can equal another type's synthesized binary name.
 * Check the declarations in this tree before qualifying any existing graph ID. */
function javaClassNameCollisions(node: SyntaxNode): ReadonlySet<string> | undefined {
  const tree = node.tree;
  if (!tree) return undefined;
  const cached = collisionsByTree.get(tree);
  if (cached) return cached;

  const names = new Set<string>();
  const collisions = new Set<string>();
  // Synthesized local and anonymous names contain '$'. Distinct ordinary
  // source names without that character cannot collide with one another or
  // with a synthesized name. Avoid walking anonymous bodies in that case.
  const possibleCollision = tree.rootNode.descendantsOfType(namedTypeNodes).some((type) => {
    const name = type.childForFieldName('name')?.text;
    if (!name) return false;
    if (name.includes('$') || names.has(name)) return true;
    names.add(name);
    return false;
  });
  if (!possibleCollision) {
    collisionsByTree.set(tree, collisions);
    return collisions;
  }
  names.clear();
  for (const candidate of tree.rootNode.descendantsOfType(collisionCandidateNodes)) {
    // Start at anonymous bodies so deeply nested plain constructor calls
    // never incur an enclosing-type walk. Enum constant bodies share this shape.
    const isBody = candidate.type === 'class_body';
    const type = isBody ? candidate.parent : candidate;
    if (!type || (isBody && !anonymousClassHosts.has(type.type))) continue;
    const name =
      synthesizeJavaTypeIdentity(type)?.name ??
      (isBody ? undefined : type.childForFieldName('name')?.text);
    if (!name) continue;
    if (names.has(name)) collisions.add(name);
    names.add(name);
  }
  collisionsByTree.set(tree, collisions);
  return collisions;
}

const extractJavaClassSymbol: ClassExtractor['extract'] = (node, fallback) => {
  const symbol = declaredTypes.extract(node, fallback);
  if (!symbol) return null;
  if (synthesizeJavaTypeIdentity(node)) {
    // The synthesized spelling already includes every enclosing type. Only
    // the package should prefix it, including for members of local classes.
    const root = node.tree?.rootNode;
    symbol.qualifiedName = root
      ? (declaredTypes.qualifyScopeName?.(root, symbol.name) ?? symbol.name)
      : symbol.name;
  } else if (javaClassNameCollisions(node)?.has(symbol.name)) {
    symbol.qualifiedNodeId = true;
  }
  return symbol;
};

export const javaClassExtractor: ClassExtractor = {
  ...declaredTypes,
  extract: extractJavaClassSymbol,
  extractQualifiedName(node, simpleName) {
    if (node.type === 'annotation_type_declaration')
      return declaredTypes.qualifyScopeName?.(node, simpleName) ?? null;
    return extractJavaClassSymbol(node, { name: simpleName })?.qualifiedName ?? null;
  },
};

export function resolveJavaCollisionOwner(node: SyntaxNode) {
  const name = node.childForFieldName('name')?.text;
  if (!name || !javaClassNameCollisions(node)?.has(name)) return null;
  const symbol = extractJavaClassSymbol(node);
  return symbol?.qualifiedNodeId ? { name: symbol.qualifiedName, label: symbol.type } : null;
}

/** Join the scope definition to the exact published type while retaining its source binding. */
export function javaClassQualifierCaptures(node: SyntaxNode, name: string) {
  if (!javaClassNameCollisions(node)?.has(name)) return undefined;
  const qualifiedName = javaClassExtractor.extractQualifiedName(node, name);
  if (!qualifiedName) return undefined;
  return {
    '@declaration.qualified_name': syntheticCapture(
      '@declaration.qualified_name',
      node,
      qualifiedName,
    ),
  };
}
