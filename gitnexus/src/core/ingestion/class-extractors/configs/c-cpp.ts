// gitnexus/src/core/ingestion/class-extractors/configs/c-cpp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import {
  extractTemplateArguments,
  stripTemplateArguments,
} from '../../utils/template-arguments.js';

/**
 * Stable segment for an anonymous `namespace { ... }`.
 *
 * Sibling order under the same parent, not a byte offset. An offset changes
 * when any edit above the namespace moves it, which would rename every member
 * inside it. Two anonymous namespaces under one parent stay `@anon1` and
 * `@anon2`. A named namespace contributes nothing here.
 */
export function cppAnonymousNamespaceSegment(node: SyntaxNode): string | undefined {
  if (node.type !== 'namespace_definition' || node.childForFieldName('name')) return undefined;
  const parent = node.parent;
  const siblings = parent?.namedChildren;
  if (!siblings) return '@anon1';
  let ordinal = 0;
  for (const child of siblings) {
    if (child.type !== 'namespace_definition' || child.childForFieldName('name')) continue;
    ordinal += 1;
    if (child.startIndex === node.startIndex && child.endIndex === node.endIndex) {
      return `@anon${ordinal}`;
    }
  }
  return `@anon${ordinal > 0 ? ordinal : 1}`;
}

function shouldSkipCppTemplateDuplicateCapture(
  captureMap: Record<string, { text: string } | undefined>,
  definitionName: string | undefined,
  capturedName: string | undefined,
): boolean {
  if (captureMap['template-arguments'] !== undefined) return false;
  if (!definitionName) return false;
  const argsFromDefinitionName = extractTemplateArguments(definitionName);
  if (argsFromDefinitionName === undefined) return false;
  const argsFromCaptureName = capturedName ? extractTemplateArguments(capturedName) : undefined;
  // Generic class capture emits only `List`, while the specialization-aware
  // capture emits `List` + `@declaration.template-arguments`. Skip the former
  // when the declaration name itself is templated to avoid duplicate class defs.
  return argsFromCaptureName === undefined;
}

function extractCppTemplateArgumentsWithFallback(
  captureMap: Record<string, { text: string } | undefined>,
  definitionName: string | undefined,
  capturedName: string | undefined,
): string[] | undefined {
  return (
    (captureMap['template-arguments']
      ? extractTemplateArguments(captureMap['template-arguments'].text)
      : undefined) ??
    (definitionName ? extractTemplateArguments(definitionName) : undefined) ??
    (capturedName ? extractTemplateArguments(capturedName) : undefined)
  );
}

export const cClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.C,
  typeDeclarationNodes: ['struct_specifier', 'enum_specifier'],
};

export const cppClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,
  typeDeclarationNodes: ['class_specifier', 'struct_specifier', 'enum_specifier'],
  // #1995: `union_specifier` is included so a type nested in a NAMED union
  // (`union U1 { struct Inner {...} }`) qualifies as `U1.Inner`. Anonymous unions
  // have no `name` child → extractScopeSegmentsFromNode returns [] → they correctly
  // contribute nothing (members inject into the enclosing scope). C uses the
  // separate cClassConfig (no qualifiedNodeId), so it is intentionally untouched.
  ancestorScopeNodeTypes: [
    'namespace_definition',
    'class_specifier',
    'struct_specifier',
    'union_specifier',
  ],
  // #1978: key nested-type nodes by their fully-qualified path (Outer.Inner) so
  // same-tail nested types in one TU stay distinct instead of silently merging.
  qualifiedNodeId: true,
  // Member ids follow the same path as the class node. Without this, a method
  // keys off the tail type name and `N::Box::save` collapses onto `Box.save`.
  qualifyMemberOwner: true,
  // #1995: anonymous namespaces have no `name` child, so the generic scope walker
  // drops them (empty segment) and two `namespace { struct Inner {} }` blocks in one
  // TU collapse onto a single `Inner` node. Give each anonymous namespace_definition
  // a per-parent sibling ordinal (`@anon1`, `@anon2`) so the nested types stay
  // distinct. The ordinal is stable across an edit that only shifts bytes above
  // the namespace; a start-byte stand-in is not. Returning `undefined` for every
  // other scope — named namespaces (incl. `inline namespace`), classes, structs,
  // named unions — falls through to the default name-based extraction. Anonymous
  // UNIONS are not matched here (members inject into the enclosing scope).
  extractScopeSegments: (node) => {
    const anon = cppAnonymousNamespaceSegment(node);
    return anon === undefined ? undefined : [anon];
  },
  extractName: (node) => {
    const nameNode = node.childForFieldName?.('name');
    if (!nameNode) return undefined;
    if (nameNode.type !== 'template_type') return undefined;
    return stripTemplateArguments(nameNode.text);
  },
  extractTemplateArguments: (node) => {
    const nameNode = node.childForFieldName?.('name');
    if (!nameNode || nameNode.type !== 'template_type') return undefined;
    return extractTemplateArguments(nameNode.text);
  },
  shouldSkipClassCapture: ({ captureMap, definitionNode, nameNode }) =>
    shouldSkipCppTemplateDuplicateCapture(
      captureMap,
      definitionNode?.childForFieldName?.('name')?.text,
      nameNode?.text,
    ),
  extractTemplateArgumentsFromCapture: ({ captureMap, definitionNode, nameNode }) =>
    extractCppTemplateArgumentsWithFallback(
      captureMap,
      definitionNode?.childForFieldName?.('name')?.text,
      nameNode?.text,
    ),
};
