// gitnexus/src/core/ingestion/field-extractors/zig.ts

import { SupportedLanguages } from 'gitnexus-shared';
import { BaseFieldExtractor } from '../field-extractor.js';
import type {
  ExtractedFields,
  FieldExtractorContext,
  FieldInfo,
  FieldVisibility,
} from '../field-types.js';
import { extractSimpleTypeName } from '../type-extractors/shared.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

/**
 * Zig field extractor.
 *
 * Zig containers are anonymous values bound to a `variable_declaration`:
 *   const Pioneer = struct { state: State, energy: u32 };
 *   const State = enum { idle, working };
 *
 * The class extractor identifies a variable_declaration as a "type
 * declaration" when its RHS is struct_declaration / enum_declaration /
 * union_declaration. This field extractor mirrors that decision and
 * walks into the container to enumerate its `container_field` members.
 *
 * Visibility: Zig has no per-field modifier; container fields are part of
 * the type's public surface, so we report all as 'public'.
 */
export class ZigFieldExtractor extends BaseFieldExtractor {
  language = SupportedLanguages.Zig;

  isTypeDeclaration(node: SyntaxNode): boolean {
    if (node.type !== 'variable_declaration') return false;
    return findContainerChild(node) !== null;
  }

  protected extractVisibility(_node: SyntaxNode): FieldVisibility {
    return 'public';
  }

  extract(node: SyntaxNode, context: FieldExtractorContext): ExtractedFields | null {
    if (!this.isTypeDeclaration(node)) return null;

    // Owner name = the bound identifier, not a 'name' field.
    let ownerFqn: string | undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'identifier') {
        ownerFqn = c.text;
        break;
      }
    }
    if (!ownerFqn) return null;

    const container = findContainerChild(node);
    if (!container) return null;

    const fields: FieldInfo[] = [];
    for (let i = 0; i < container.namedChildCount; i++) {
      const child = container.namedChild(i);
      if (child?.type !== 'container_field') continue;
      const field = this.buildField(child, context);
      if (field) fields.push(field);
    }

    return { ownerFqn, fields, nestedTypes: [] };
  }

  private buildField(node: SyntaxNode, context: FieldExtractorContext): FieldInfo | null {
    const nameNode = node.childForFieldName?.('name');
    const name = nameNode?.text;
    if (!name) return null;

    const typeNode = node.childForFieldName?.('type');
    const rawType = typeNode
      ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
      : null;
    const type = this.normalizeType(rawType);

    return {
      name,
      type,
      visibility: 'public',
      isStatic: false,
      isReadonly: false,
      sourceFile: context.filePath,
      line: node.startPosition.row + 1,
    };
  }
}

function findContainerChild(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (
      c?.type === 'struct_declaration' ||
      c?.type === 'enum_declaration' ||
      c?.type === 'union_declaration'
    ) {
      return c;
    }
  }
  return null;
}

export const zigFieldExtractor = new ZigFieldExtractor();
