// gitnexus/src/core/ingestion/field-extractors/configs/python.ts

import { SupportedLanguages } from '../../../../config/supported-languages.js';
import type { FieldExtractionConfig } from '../generic.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';

/**
 * Python field extraction config.
 *
 * Python class fields appear as:
 * - Annotated assignments: `name: str = ""`
 * - Plain assignments in __init__: `self.name = value`
 *
 * For AST-level extraction we handle expression_statement containing
 * assignment or type nodes inside a class body block.
 */
export const pythonConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Python,
  typeDeclarationNodes: ['class_definition'],
  fieldNodeTypes: ['expression_statement'],
  bodyNodeTypes: ['block'],
  defaultVisibility: 'public',

  extractName(node) {
    // expression_statement wrapping an assignment or type
    const inner = node.firstNamedChild;
    if (!inner) return undefined;

    // Annotated assignment:  name: str = "default"
    // tree-sitter node: type (expression_statement (type (identifier) (type) ...))
    if (inner.type === 'type') {
      const ident = inner.childForFieldName('name') ?? inner.firstNamedChild;
      return ident?.type === 'identifier' ? ident.text : undefined;
    }

    // assignment: x = 5  (class variable)
    if (inner.type === 'assignment') {
      const left = inner.childForFieldName('left');
      if (left?.type === 'identifier') return left.text;
    }

    return undefined;
  },

  extractType(node) {
    const inner = node.firstNamedChild;
    if (!inner) return undefined;

    // Annotated assignment with value: `name: str = "default"`
    // AST: expression_statement > type > [identifier, type, ...]
    if (inner.type === 'type') {
      const typeNode = inner.childForFieldName('type') ?? inner.namedChild(1);
      if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    }

    // Annotation without value: `address: Address`
    // AST: expression_statement > assignment > [identifier, type]
    if (inner.type === 'assignment') {
      for (let i = 0; i < inner.childCount; i++) {
        const child = inner.child(i);
        if (child?.type === 'type') {
          const typeId = child.firstNamedChild;
          if (typeId) return extractSimpleTypeName(typeId) ?? typeId.text?.trim();
        }
      }
    }

    return undefined;
  },

  extractVisibility(node) {
    const inner = node.firstNamedChild;
    let name: string | undefined;
    if (inner?.type === 'type') {
      const ident = inner.childForFieldName('name') ?? inner.firstNamedChild;
      name = ident?.text;
    } else if (inner?.type === 'assignment') {
      const left = inner.childForFieldName('left');
      name = left?.text;
    }
    if (!name) return 'public';
    if (name.startsWith('__') && !name.endsWith('__')) return 'private';
    if (name.startsWith('_')) return 'protected';
    return 'public';
  },

  isStatic(_node) {
    // Reports syntactic static keyword — Python class variables don't use explicit static keyword.
    // Instance variables (self.x) live in __init__ and are not extracted here.
    return false;
  },

  isReadonly(_node) {
    return false;
  },
};
