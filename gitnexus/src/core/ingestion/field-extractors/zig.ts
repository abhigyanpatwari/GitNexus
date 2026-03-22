import { SupportedLanguages } from 'gitnexus-shared';
import { BaseFieldExtractor } from '../field-extractor.js';
import type {
  FieldExtractorContext,
  ExtractedFields,
  FieldInfo,
  FieldVisibility,
} from '../field-types.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { extractSimpleTypeName } from '../type-extractors/shared.js';

const ZIG_CONTAINER_TYPES = new Set(['struct_declaration', 'enum_declaration', 'union_declaration']);

const findBindingName = (node: SyntaxNode): string | undefined => {
  if (node.parent?.type !== 'variable_declaration') return undefined;
  const nameNode = node.parent.childForFieldName?.('name');
  if (nameNode) return nameNode.text;

  for (let i = 0; i < node.parent.namedChildCount; i++) {
    const child = node.parent.namedChild(i);
    if (
      child &&
      (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'constant')
    ) {
      return child.text;
    }
  }

  return undefined;
};

const extractFieldType = (node: SyntaxNode): string | null => {
  const typeNode = node.childForFieldName?.('type');
  if (!typeNode) return null;
  return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null;
};

export class ZigFieldExtractor extends BaseFieldExtractor {
  language = SupportedLanguages.Zig;

  isTypeDeclaration(node: SyntaxNode): boolean {
    return ZIG_CONTAINER_TYPES.has(node.type);
  }

  protected extractVisibility(_node: SyntaxNode): FieldVisibility {
    return 'public';
  }

  extract(node: SyntaxNode, context: FieldExtractorContext): ExtractedFields | null {
    if (!this.isTypeDeclaration(node)) return null;

    const fields: FieldInfo[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type !== 'container_field') continue;

      const nameNode = child.childForFieldName?.('name');
      if (!nameNode) continue;

      let type = extractFieldType(child);
      if (type) {
        type = this.normalizeType(type);
        const resolved = this.resolveType(type, context);
        if (resolved) type = resolved;
      }

      fields.push({
        name: nameNode.text,
        type,
        visibility: this.extractVisibility(child),
        isStatic: false,
        isReadonly: false,
        sourceFile: context.filePath,
        line: child.startPosition.row + 1,
      });
    }

    return {
      ownerFqn: findBindingName(node) ?? '<anonymous>',
      fields,
      nestedTypes: [],
    };
  }
}
