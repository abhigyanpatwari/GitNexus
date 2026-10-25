// gitnexus/src/core/ingestion/class-extractors/configs/typescript-javascript.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';
import type { LanguageProvider } from '../../language-provider.js';
import { createClassExtractor } from '../generic.js';
import { positionQualifiedCallableName } from '../../workers/callable-id.js';

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
    'class',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'enum_declaration',
  ],
  extractScopeSegments(node) {
    const name = node.childForFieldName('name');
    return node.type === 'class' && name !== null
      ? [positionQualifiedCallableName(name.text, node.startPosition)]
      : undefined;
  },
};

export const typescriptClassConfig: ClassExtractionConfig = {
  ...shared,
  language: SupportedLanguages.TypeScript,
};

export const javascriptClassConfig: ClassExtractionConfig = {
  ...shared,
  language: SupportedLanguages.JavaScript,
};

export const vueClassConfig: ClassExtractionConfig = {
  ...shared,
  language: SupportedLanguages.Vue,
};

/** Expressions can reuse a local name in sibling factories or methods. */
export const createTsJsClassExtractor = (config: ClassExtractionConfig) => {
  const extractor = createClassExtractor(config);
  const extract: typeof extractor.extract = (node, fallback) => {
    const owner = extractor.extract(node, fallback);
    return owner !== null && node.type === 'class'
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
  };
};

const ownerExtractor = createTsJsClassExtractor(typescriptClassConfig);

/** Use the definition's qualified name for both the owner and its member IDs. */
export const resolveTsJsContainerTypeOwner: NonNullable<
  LanguageProvider['resolveContainerTypeOwner']
> = (node) => {
  const owner = ownerExtractor.extract(node);
  return owner === null ? null : { name: owner.qualifiedName, label: owner.type };
};
