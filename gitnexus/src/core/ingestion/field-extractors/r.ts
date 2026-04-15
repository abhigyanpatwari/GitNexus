// gitnexus/src/core/ingestion/field-extractors/r.ts

/**
 * R field extractor — hand-written because R expresses classes as function
 * calls (R6Class(), setClass(), setRefClass()) rather than dedicated class syntax, so the
 * generic config-driven factory cannot navigate the AST.
 *
 * Handles:
 * - R6 fields: non-function entries in public/private list()
 * - R5 fields: setRefClass("Foo", fields = list(name = "character"))
 * - S4 representation/slots: setClass("Foo", representation(name = "character"))
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { BaseFieldExtractor } from '../field-extractor.js';
import type {
  FieldExtractorContext,
  ExtractedFields,
  FieldInfo,
  FieldVisibility,
} from '../field-types.js';

export class RFieldExtractor extends BaseFieldExtractor {
  language = SupportedLanguages.R;

  isTypeDeclaration(node: SyntaxNode): boolean {
    return isR6Class(node) || isS4Class(node);
  }

  protected extractVisibility(_node: SyntaxNode): FieldVisibility {
    return 'public';
  }

  extract(node: SyntaxNode, context: FieldExtractorContext): ExtractedFields | null {
    if (isR6Class(node)) return this.extractR6Fields(node, context);
    if (isS4Class(node)) return this.extractS4Fields(node, context);
    return null;
  }

  // --------------------------------------------------------------------------
  // R6 field extraction
  // --------------------------------------------------------------------------

  private extractR6Fields(
    node: SyntaxNode,
    context: FieldExtractorContext,
  ): ExtractedFields | null {
    const ownerFqn = node.childForFieldName('lhs')?.text;
    if (!ownerFqn) return null;

    const call = node.childForFieldName('rhs');
    if (!call) return null;

    const args = call.childForFieldName('arguments');
    if (!args) return null;

    const fields: FieldInfo[] = [];

    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      if (!arg || arg.type !== 'argument') continue;

      const section = arg.childForFieldName('name')?.text;
      if (section !== 'public' && section !== 'private') continue;

      const visibility: FieldVisibility = section === 'private' ? 'private' : 'public';
      const listCall = arg.childForFieldName('value');
      if (!listCall || listCall.type !== 'call') continue;

      const listArgs = listCall.childForFieldName('arguments');
      if (!listArgs) continue;

      for (let j = 0; j < listArgs.namedChildCount; j++) {
        const entry = listArgs.namedChild(j);
        if (!entry || entry.type !== 'argument') continue;

        const nameNode = entry.childForFieldName('name');
        const valueNode = entry.childForFieldName('value');
        if (!nameNode) continue;

        // Skip function entries (those are methods, not fields)
        if (valueNode?.type === 'function_definition') continue;

        fields.push({
          name: nameNode.text,
          type: inferR6FieldType(valueNode),
          visibility,
          isStatic: false,
          isReadonly: false,
          sourceFile: context.filePath,
          line: entry.startPosition.row + 1,
        });
      }
    }

    return fields.length > 0 ? { ownerFqn, fields, nestedTypes: [] } : null;
  }

  // --------------------------------------------------------------------------
  // S4 field extraction (representation / slots / fields)
  // --------------------------------------------------------------------------

  private extractS4Fields(
    node: SyntaxNode,
    context: FieldExtractorContext,
  ): ExtractedFields | null {
    const args = node.childForFieldName('arguments');
    if (!args) return null;

    // First string argument is the class name
    let ownerFqn: string | undefined;
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      if (!arg || arg.type !== 'argument') continue;
      const val = arg.childForFieldName('value');
      if (val?.type === 'string') {
        const content = val.namedChildren.find((c) => c.type === 'string_content');
        ownerFqn = content?.text ?? val.text.replace(/^["']|["']$/g, '');
        break;
      }
    }
    if (!ownerFqn) return null;

    const fields: FieldInfo[] = [];

    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      if (!arg || arg.type !== 'argument') continue;

      const paramName = arg.childForFieldName('name')?.text;
      if (paramName !== 'representation' && paramName !== 'slots' && paramName !== 'fields')
        continue;

      const slotCall = arg.childForFieldName('value');
      if (!slotCall || slotCall.type !== 'call') continue;

      const slotArgs = slotCall.childForFieldName('arguments');
      if (!slotArgs) continue;

      for (let j = 0; j < slotArgs.namedChildCount; j++) {
        const slot = slotArgs.namedChild(j);
        if (!slot || slot.type !== 'argument') continue;

        const slotName = slot.childForFieldName('name');
        const slotType = slot.childForFieldName('value');
        if (!slotName) continue;

        const typeName = extractQuotedTypeName(slotType);

        fields.push({
          name: slotName.text,
          type: typeName,
          visibility: 'public',
          isStatic: false,
          isReadonly: false,
          sourceFile: context.filePath,
          line: slot.startPosition.row + 1,
        });
      }
    }

    return fields.length > 0 ? { ownerFqn, fields, nestedTypes: [] } : null;
  }
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

export function findRFieldOwnerNode(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node;
  while (current) {
    if (isR6Class(current) || isS4Class(current)) return current;
    current = current.parent;
  }
  return null;
}

export function getRTopLevelPropertyOwnerName(node: SyntaxNode): string | null {
  const ownerNode = findRFieldOwnerNode(node);
  if (!ownerNode) return null;

  if (ownerNode.type === 'binary_operator') {
    return ownerNode.childForFieldName('lhs')?.text ?? null;
  }

  const args = ownerNode.childForFieldName('arguments');
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg || arg.type !== 'argument') continue;
    const value = arg.childForFieldName('value');
    if (value?.type !== 'string') continue;
    return extractQuotedTypeName(value);
  }
  return null;
}

/** Check if a binary_operator node is an R6 class assignment. */
function isR6Class(node: SyntaxNode): boolean {
  if (node.type !== 'binary_operator') return false;
  const rhs = node.childForFieldName('rhs');
  if (!rhs || rhs.type !== 'call') return false;
  const fn = rhs.childForFieldName('function');
  if (!fn) return false;
  // R6Class(...)
  if (fn.type === 'identifier' && fn.text === 'R6Class') return true;
  // R6::R6Class(...)
  if (fn.type === 'namespace_operator') {
    const rhsFn = fn.childForFieldName('rhs');
    return rhsFn?.text === 'R6Class';
  }
  return false;
}

/** Check if a call node is setClass() or setRefClass(). */
function isS4Class(node: SyntaxNode): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  return fn?.type === 'identifier' && (fn.text === 'setClass' || fn.text === 'setRefClass');
}

/** Infer a basic type from an R6 field default value. */
function inferR6FieldType(valueNode: SyntaxNode | null): string | null {
  if (!valueNode) return null;
  switch (valueNode.type) {
    case 'null':
      return null;
    case 'true':
    case 'false':
      return 'logical';
    case 'float':
      return 'numeric';
    case 'integer':
      return 'integer';
    case 'string':
      return 'character';
    default:
      // NA variants
      if (valueNode.type === 'identifier') {
        const text = valueNode.text;
        if (text === 'NA_character_') return 'character';
        if (text === 'NA_integer_') return 'integer';
        if (text === 'NA_real_') return 'numeric';
        if (text === 'NA_complex_') return 'complex';
      }
      return null;
  }
}

function extractQuotedTypeName(node: SyntaxNode | null): string | null {
  if (!node || node.type !== 'string') return null;
  const content = node.namedChildren.find((c) => c.type === 'string_content');
  return content?.text ?? node.text.replace(/^["']|["']$/g, '');
}
