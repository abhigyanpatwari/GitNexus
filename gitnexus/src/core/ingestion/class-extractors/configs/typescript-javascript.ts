// gitnexus/src/core/ingestion/class-extractors/configs/typescript-javascript.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { LanguageProvider } from '../../language-provider.js';
import { createClassExtractor } from '../generic.js';
import { positionQualifiedCallableName } from '../../workers/callable-id.js';

const classDeclarations = ['class_declaration', 'abstract_class_declaration'];
const repeatedClasses = new WeakMap<SyntaxNode['tree'], ReadonlySet<number>>();

function needsPosition(node: SyntaxNode): boolean {
  if (node.type === 'class') return true;
  if (!classDeclarations.includes(node.type)) return false;
  // Only block-local declarations can hide an ordinary class of the same name.
  // Keep the public graph IDs of module declarations and unique local classes.
  let parent = node.parent;
  while (parent && parent.type !== 'statement_block' && parent.type !== 'switch_body') {
    parent = parent.parent;
  }
  if (!parent || ['internal_module', 'module'].includes(parent.parent?.type ?? '')) return false;
  const tree = node.tree;
  if (!tree) return false;
  let repeated = repeatedClasses.get(tree);
  if (!repeated) {
    const first = new Map<string, number>();
    const duplicates = new Set<number>();
    for (const declaration of tree.rootNode.descendantsOfType(classDeclarations)) {
      const name = declaration.childForFieldName('name')?.text;
      if (!name) continue;
      const qualified = positionlessClassExtractor.qualifyScopeName!(declaration, name);
      const prior = first.get(qualified ?? name);
      if (prior !== undefined) {
        duplicates.add(prior);
        duplicates.add(declaration.id);
      } else first.set(qualified ?? name, declaration.id);
    }
    repeatedClasses.set(tree, duplicates);
    repeated = duplicates;
  }
  return repeated.has(node.id);
}

const shared: Omit<ClassExtractionConfig, 'language'> = {
  // Nested class expressions and their member-owner edges must use the same
  // qualified identity, including when an outer class has the same name.
  qualifiedNodeId: true,
  typeDeclarationNodes: [
    'class',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'enum_declaration',
  ],
  ancestorScopeNodeTypes: [
    'internal_module',
    'module',
    'class',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'enum_declaration',
  ],
  extractScopeSegments(node) {
    const name = node.childForFieldName('name');
    return name !== null && needsPosition(node)
      ? [positionQualifiedCallableName(name.text, node.startPosition)]
      : undefined;
  },
};

export function isAnonymousDefaultClass(node: SyntaxNode): boolean {
  return (
    node.type === 'class' &&
    !node.childForFieldName('name') &&
    node.parent?.type === 'export_statement' &&
    node.parent.children.some((child) => child?.type === 'default')
  );
}

export const typescriptClassConfig: ClassExtractionConfig = {
  ...shared,
  language: SupportedLanguages.TypeScript,
  extractName: (node) => (isAnonymousDefaultClass(node) ? 'default' : undefined),
};

export const javascriptClassConfig: ClassExtractionConfig = {
  ...shared,
  language: SupportedLanguages.JavaScript,
};

// Use the same enclosing namespace and class segments as the published ID,
// before any local position suffix is added.
const positionlessClassExtractor = createClassExtractor({
  ...typescriptClassConfig,
  extractScopeSegments: undefined,
});

export const vueClassConfig: ClassExtractionConfig = {
  ...shared,
  language: SupportedLanguages.Vue,
};

/** Expressions can reuse a local name in sibling factories or methods. */
export const createTsJsClassExtractor = (config: ClassExtractionConfig) => {
  const extractor = createClassExtractor(config);
  const extract: typeof extractor.extract = (node, fallback) => {
    const owner = extractor.extract(node, fallback);
    return owner !== null && needsPosition(node)
      ? {
          ...owner,
          qualifiedName: positionQualifiedCallableName(owner.qualifiedName, node.startPosition),
        }
      : owner;
  };
  return {
    ...extractor,
    extract,
    extractQualifiedName: (node: Parameters<typeof extract>[0], name: string) =>
      extract(node, { name })?.qualifiedName ?? null,
    // TypeAlias nodes keep simple IDs, even inside qualified class owners.
    qualifyScopeName: (node: Parameters<typeof extract>[0], name: string) =>
      node.type === 'type_alias_declaration'
        ? name
        : (extractor.qualifyScopeName?.(node, name) ?? name),
  };
};

const ownerExtractor = createTsJsClassExtractor(typescriptClassConfig);

/** Use the definition's qualified name for both the owner and its member IDs. */
export const resolveTsJsContainerTypeOwner = ((node: SyntaxNode) => {
  const owner = ownerExtractor.extract(node);
  return owner === null ? null : { name: owner.qualifiedName, label: owner.type };
}) satisfies NonNullable<LanguageProvider['resolveContainerTypeOwner']>;
