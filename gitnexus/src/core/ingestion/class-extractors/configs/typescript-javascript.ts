// gitnexus/src/core/ingestion/class-extractors/configs/typescript-javascript.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';
import { outerParenthesizedExpression, type SyntaxNode } from '../../utils/ast-helpers.js';
import type { LanguageProvider } from '../../language-provider.js';
import { createClassExtractor } from '../generic.js';
import { positionQualifiedCallableName } from '../../workers/callable-id.js';

const classDeclarations = ['class_declaration', 'abstract_class_declaration'];
const repeatedClasses = new WeakMap<SyntaxNode['tree'], ReadonlySet<number>>();
const enumPositions = new WeakMap<
  SyntaxNode['tree'],
  ReadonlyMap<number, SyntaxNode['startPosition']>
>();

function localBlock(node: SyntaxNode): SyntaxNode | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'statement_block' || parent.type === 'switch_body') {
      return ['internal_module', 'module'].includes(parent.parent?.type ?? '') ? undefined : parent;
    }
  }
}

function needsPosition(node: SyntaxNode): boolean {
  if (node.type === 'class') return true;
  if (!classDeclarations.includes(node.type)) return false;
  // Only block-local declarations can hide an ordinary class of the same name.
  // Keep the public graph IDs of module declarations and unique local classes.
  if (!localBlock(node)) return false;
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

/** Declarations of one enum can merge within a scope. A shadowing enum in
 * another scope needs a different owner for both its type and its members. */
function localTypeName(node: SyntaxNode, name: string): string | undefined {
  if (node.type !== 'enum_declaration') {
    return needsPosition(node)
      ? positionQualifiedCallableName(name, node.startPosition)
      : undefined;
  }
  if (!node.tree || !localBlock(node)) return;
  let positions = enumPositions.get(node.tree);
  if (!positions) {
    const groups = new Map<string, Map<number, SyntaxNode[]>>();
    for (const decl of node.tree.rootNode.descendantsOfType('enum_declaration')) {
      const simple = decl.childForFieldName('name')?.text;
      if (!simple) continue;
      const key = positionlessClassExtractor.qualifyScopeName!(decl, simple) ?? simple;
      const scope = localBlock(decl)?.id ?? 0;
      let owners = groups.get(key);
      if (!owners) {
        owners = new Map();
        groups.set(key, owners);
      }
      const declarations = owners.get(scope);
      if (declarations) declarations.push(decl);
      else owners.set(scope, [decl]);
    }
    const result = new Map<number, SyntaxNode['startPosition']>();
    for (const owners of groups.values()) {
      if (owners.size < 2) continue;
      for (const declarations of owners.values()) {
        for (const decl of declarations) result.set(decl.id, declarations[0].startPosition);
      }
    }
    enumPositions.set(node.tree, result);
    positions = result;
  }
  const anchor = positions.get(node.id);
  return anchor && positionQualifiedCallableName(name, anchor);
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
    const localName = name && localTypeName(node, name.text);
    return localName ? [localName] : undefined;
  },
};

const groupedClassKeywords = new WeakMap<SyntaxNode['tree'], Map<number, SyntaxNode | undefined>>();

function defaultKeyword(statement: SyntaxNode | null): SyntaxNode | undefined {
  if (statement?.type === 'export_statement')
    return statement.children.find((child) => child.type === 'default');
}

/** ECMAScript named evaluation carries `default` through grouping parentheses. */
export function anonymousDefaultClassKeyword(node: SyntaxNode): SyntaxNode | undefined {
  if (node.type !== 'class' || node.childForFieldName('name')) return;
  const parent = node.parent;
  if (parent?.type !== 'parenthesized_expression') return defaultKeyword(parent);
  // Extraction asks for the enclosing class of each member. Follow deep grouping once per class.
  const tree = node.tree;
  let keywords = tree && groupedClassKeywords.get(tree);
  if (keywords?.has(node.id)) return keywords.get(node.id);
  const keyword = defaultKeyword(outerParenthesizedExpression(parent).parent);
  if (tree) {
    if (!keywords) {
      keywords = new Map();
      groupedClassKeywords.set(tree, keywords);
    }
    keywords.set(node.id, keyword);
  }
  return keyword;
}

function anonymousDefaultClassName(node: SyntaxNode): string | undefined {
  return anonymousDefaultClassKeyword(node)?.text;
}

export const typescriptClassConfig: ClassExtractionConfig = {
  ...shared,
  language: SupportedLanguages.TypeScript,
  extractName: anonymousDefaultClassName,
};

export const javascriptClassConfig: ClassExtractionConfig = {
  ...shared,
  language: SupportedLanguages.JavaScript,
  extractName: anonymousDefaultClassName,
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
    const qualifiedName = owner && localTypeName(node, owner.qualifiedName);
    return owner && qualifiedName ? { ...owner, qualifiedName } : owner;
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

/** A class expression with no graph owner still owns its members lexically. */
export const resolveTsJsEnclosingTypeOwner = ((node: SyntaxNode) =>
  resolveTsJsContainerTypeOwner(node) ??
  (node.type === 'class' ? false : null)) satisfies NonNullable<
  LanguageProvider['resolveContainerTypeOwner']
>;
