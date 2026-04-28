import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NodeLabel } from 'gitnexus-shared';
import type {
  ClassExtractionConfig,
  ClassExtractor,
  ClassLikeNodeLabel,
  ExtractedClassSymbol,
} from '../class-types.js';

const DEFAULT_SCOPE_NAME_NODE_TYPES = new Set([
  'nested_namespace_specifier',
  'scoped_identifier',
  'scoped_type_identifier',
  'qualified_name',
  'namespace_name',
  'namespace_identifier',
  'package_identifier',
  'type_identifier',
  'identifier',
  'name',
  'constant',
]);

const DEFAULT_TYPE_NAME_NODE_TYPES = new Set([
  'type_identifier',
  'identifier',
  'simple_identifier',
  'namespace_identifier',
  'constant',
  'name',
]);

const DEFAULT_LABEL_BY_NODE_TYPE: Record<string, ClassLikeNodeLabel> = {
  class_declaration: 'Class',
  abstract_class_declaration: 'Class',
  interface_declaration: 'Interface',
  struct_declaration: 'Struct',
  record_declaration: 'Record',
  enum_declaration: 'Enum',
  class_definition: 'Class',
  struct_specifier: 'Struct',
  class_specifier: 'Class',
  enum_specifier: 'Enum',
  struct_item: 'Struct',
  enum_item: 'Enum',
  class: 'Class',
  object_declaration: 'Class',
  companion_object: 'Class',
  protocol_declaration: 'Interface',
  extension_declaration: 'Class',
};

const CLASS_LIKE_LABELS = new Set<ClassLikeNodeLabel>([
  'Class',
  'Struct',
  'Interface',
  'Enum',
  'Record',
]);

const normalizeQualifiedName = (value: string): string =>
  value
    .replace(/\s+/g, '')
    .replace(/^::/, '')
    .replace(/::/g, '.')
    .replace(/\\/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '');

const splitQualifiedName = (value: string): string[] => {
  const normalized = normalizeQualifiedName(value);
  return normalized ? normalized.split('.').filter(Boolean) : [];
};

const extractScopeSegmentsFromNode = (
  scopeNode: SyntaxNode,
  scopeNameNodeTypes: ReadonlySet<string>,
): string[] => {
  const nameNode =
    scopeNode.childForFieldName?.('name') ??
    scopeNode.namedChildren?.find((child) => scopeNameNodeTypes.has(child.type));
  return nameNode ? splitQualifiedName(nameNode.text) : [];
};

const extractTypeNameFromNode = (node: SyntaxNode): string | undefined => {
  const nameField = node.childForFieldName?.('name');
  if (nameField) return nameField.text;
  const nameChild = node.namedChildren?.find((child) =>
    DEFAULT_TYPE_NAME_NODE_TYPES.has(child.type),
  );
  return nameChild?.text;
};

const isClassLikeLabel = (label: NodeLabel | null | undefined): label is ClassLikeNodeLabel =>
  label !== undefined && label !== null && CLASS_LIKE_LABELS.has(label as ClassLikeNodeLabel);

export function createClassExtractor(config: ClassExtractionConfig): ClassExtractor {
  const typeDeclarationSet = new Set(config.typeDeclarationNodes);
  const fileScopeSet = new Set(config.fileScopeNodeTypes ?? []);
  const ancestorScopeSet = new Set(config.ancestorScopeNodeTypes ?? []);
  const scopeNameNodeTypes = new Set([
    ...DEFAULT_SCOPE_NAME_NODE_TYPES,
    ...(config.scopeNameNodeTypes ?? []),
  ]);

  const buildQualifiedName = (node: SyntaxNode, simpleName: string): string => {
    let root = node;
    while (root.parent) root = root.parent;

    const readScopeSegments = (scopeNode: SyntaxNode): string[] =>
      config.extractScopeSegments?.(scopeNode) ??
      extractScopeSegmentsFromNode(scopeNode, scopeNameNodeTypes);

    const fileScopeSegments: string[] = [];
    for (const child of root.namedChildren ?? []) {
      if (fileScopeSet.has(child.type)) {
        fileScopeSegments.push(...readScopeSegments(child));
      }
    }

    const ancestorScopes: string[][] = [];
    let current = node.parent;
    while (current) {
      if (ancestorScopeSet.has(current.type)) {
        const segments = readScopeSegments(current);
        if (segments.length > 0) ancestorScopes.push(segments);
      }
      current = current.parent;
    }

    return [
      ...fileScopeSegments,
      ...ancestorScopes.reverse().flat(),
      ...splitQualifiedName(simpleName),
    ]
      .filter(Boolean)
      .join('.');
  };

  const extract = (
    node: SyntaxNode,
    fallback?: {
      name?: string;
      type?: NodeLabel | null;
    },
  ): ExtractedClassSymbol | null => {
    if (!typeDeclarationSet.has(node.type)) return null;

    const name = config.extractName?.(node) ?? extractTypeNameFromNode(node) ?? fallback?.name;
    const type =
      config.extractType?.(node) ??
      DEFAULT_LABEL_BY_NODE_TYPE[node.type] ??
      (isClassLikeLabel(fallback?.type) ? fallback.type : undefined);

    if (!name || !type) return null;

    return {
      name,
      type,
      qualifiedName: buildQualifiedName(node, name) || name,
    };
  };

  return {
    language: config.language,

    isTypeDeclaration(node: SyntaxNode): boolean {
      return typeDeclarationSet.has(node.type);
    },

    extract,

    extractQualifiedName(node: SyntaxNode, simpleName: string): string | null {
      return extract(node, { name: simpleName })?.qualifiedName ?? null;
    },
  };
}
