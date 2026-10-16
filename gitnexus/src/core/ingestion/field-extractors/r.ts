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
import { isRNamingArgument } from '../languages/r/naming-argument.js';
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

    // The class name is the `Class` argument (by name, else the first unnamed one).
    const ownerFqn = getRClassNameArgument(args);
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

      // Only an unnamed character vector (`slots = c("a", "b")`) names its slots by
      // their strings; elsewhere an unnamed string is not a slot (`representation("Base")`).
      const unnamedNamesSlots =
        paramName !== 'representation' && slotCall.childForFieldName('function')?.text === 'c';

      for (let j = 0; j < slotArgs.namedChildCount; j++) {
        const slot = slotArgs.namedChild(j);
        if (!slot || slot.type !== 'argument') continue;

        const slotName = slot.childForFieldName('name');
        const slotType = slot.childForFieldName('value');
        if (!slotName) {
          const unnamed = unnamedNamesSlots ? extractQuotedTypeName(slotType) : null;
          if (unnamed) {
            fields.push({
              name: unnamed,
              type: null,
              visibility: 'public',
              isStatic: false,
              isReadonly: false,
              sourceFile: context.filePath,
              line: slot.startPosition.row + 1,
            });
          }
          continue;
        }

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

/**
 * The class name of a `setClass` / `setRefClass` argument list: the string value of
 * the argument that takes the `Class` formal. Uses the same selection as the scope
 * query and definition hook (`isRNamingArgument`), so `contains = "Base"` or
 * `representation(...)` ahead of `Class = "A"` never names the owner.
 */
export function getRClassNameArgument(args: SyntaxNode): string | null {
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg || arg.type !== 'argument') continue;
    if (!isRNamingArgument(arg, 'Class')) continue;
    const value = arg.childForFieldName('value');
    if (value?.type !== 'string') continue;
    const name = extractQuotedTypeName(value);
    if (name) return name;
  }
  return null;
}

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
  return getRClassNameOfOwnerNode(ownerNode);
}

/**
 * The class name an R6 / S4 / RefClass owner node declares: the binding name of
 * `Foo <- R6Class(...)`, or the `Class` argument of `setClass(...)` /
 * `setRefClass(...)`. Null when `ownerNode` is not such a node. Looks at this node
 * only (no ancestor walk), so a caller visiting every ancestor stays linear.
 */
export function getRClassNameOfOwnerNode(ownerNode: SyntaxNode): string | null {
  if (!isR6Class(ownerNode) && !isS4Class(ownerNode)) return null;

  if (ownerNode.type === 'binary_operator') {
    return ownerNode.childForFieldName('lhs')?.text ?? null;
  }

  const args = ownerNode.childForFieldName('arguments');
  if (!args) return null;
  return getRClassNameArgument(args);
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
    case 'na':
      // The grammar parses NA, NA_integer_, NA_real_, NA_character_ and NA_complex_ as `na`
      // nodes, not identifiers. Plain NA is logical.
      return NA_FIELD_TYPES[valueNode.text] ?? null;
    default:
      return null;
  }
}

/** The type of each NA constant, by its spelling. */
const NA_FIELD_TYPES: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  NA: 'logical',
  NA_integer_: 'integer',
  NA_real_: 'numeric',
  NA_character_: 'character',
  NA_complex_: 'complex',
});

function extractQuotedTypeName(node: SyntaxNode | null): string | null {
  if (!node || node.type !== 'string') return null;
  const content = node.namedChildren.find((c) => c.type === 'string_content');
  return content?.text ?? node.text.replace(/^["']|["']$/g, '');
}
