import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { hasKeyword, typeFromField } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

const SCALA_VIS = new Set<FieldVisibility>(['public', 'private', 'protected', 'package']);

function extractScalaVisibility(node: SyntaxNode): FieldVisibility {
  const modifiers = node.childForFieldName('modifiers') ?? node.namedChildren[0] ?? null;
  const text = modifiers?.text ?? '';
  if (text.includes('private[') || text.includes('protected[')) return 'package';
  if (text.includes('private')) return 'private';
  if (text.includes('protected')) return 'protected';
  return 'public';
}

function isCaseClass(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.text === 'case') return true;
  }
  return false;
}

export const scalaConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Scala,
  typeDeclarationNodes: [
    'class_definition',
    'trait_definition',
    'object_definition',
    'enum_definition',
    'package_object',
  ],
  fieldNodeTypes: ['val_definition', 'val_declaration', 'var_definition', 'var_declaration'],
  bodyNodeTypes: ['template_body', 'enum_body'],
  defaultVisibility: 'public',

  extractName(node) {
    return node.childForFieldName('name')?.text ?? node.childForFieldName('pattern')?.text;
  },

  extractNames(node) {
    const directName = node.childForFieldName('name');
    if (directName?.type === 'identifier') return [directName.text];
    const patternNode = node.childForFieldName('pattern');
    if (patternNode?.type === 'identifier') return [patternNode.text];
    const identifiers =
      patternNode?.type === 'identifiers'
        ? patternNode
        : node.namedChildren.find((child) => child.type === 'identifiers');
    if (!identifiers) return [];
    const names: string[] = [];
    for (let i = 0; i < identifiers.namedChildCount; i++) {
      const child = identifiers.namedChild(i);
      if (child?.type === 'identifier') names.push(child.text);
    }
    return names;
  },

  extractType(node) {
    const direct = typeFromField(node, 'type');
    if (direct) return direct;
    const typeNode = node.childForFieldName('type');
    return typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim()) : undefined;
  },

  extractVisibility(node) {
    return extractScalaVisibility(node);
  },

  isStatic(node) {
    return node.parent?.parent?.type === 'package_object';
  },

  isReadonly(node) {
    return hasKeyword(node, 'val');
  },

  extractPrimaryFields(ownerNode, _context) {
    if (ownerNode.type !== 'class_definition') return [];
    const out: Array<{
      name: string;
      type: string | null;
      visibility: FieldVisibility;
      isStatic: boolean;
      isReadonly: boolean;
      sourceFile: string;
      line: number;
    }> = [];
    const caseClass = isCaseClass(ownerNode);
    for (let i = 0; i < ownerNode.namedChildCount; i++) {
      const child = ownerNode.namedChild(i);
      if (!child || child.type !== 'class_parameters') continue;
      for (let j = 0; j < child.namedChildCount; j++) {
        const node = child.namedChild(j);
        if (!node || node.type !== 'class_parameter') continue;
        const nameNode = node.childForFieldName('name');
        const typeNode = node.childForFieldName('type');
        if (!nameNode) continue;
        let isProperty = caseClass;
        for (let k = 0; k < node.childCount; k++) {
          const c = node.child(k);
          if (c?.text === 'val' || c?.text === 'var') isProperty = true;
        }
        if (!isProperty) continue;
        out.push({
          name: nameNode.text,
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          visibility: extractScalaVisibility(node),
          isStatic: false,
          isReadonly: !hasKeyword(node, 'var'),
          sourceFile: _context.filePath,
          line: node.startPosition.row + 1,
        });
      }
    }
    return out;
  },
};
