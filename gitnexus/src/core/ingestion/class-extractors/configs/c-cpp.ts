// gitnexus/src/core/ingestion/class-extractors/configs/c-cpp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { ClassExtractionConfig } from '../../class-types.js';
import {
  extractTemplateArguments,
  stripTemplateArguments,
} from '../../utils/template-arguments.js';

const anonNsOrdinalByTree = new WeakMap<object, Map<number, number>>();

/**
 * Deterministic per-parent ordinal (`@anon1`, `@anon2`, ...) for unnamed
 * `namespace_definition` blocks. Disambiguates sibling anonymous namespaces
 * in one file without encoding shifting byte offsets into node IDs.
 */
export const cppAnonymousNamespaceSegment = (node: SyntaxNode): string => {
  const treeKey = node.tree as object | undefined;
  const cachedByTree = treeKey ? anonNsOrdinalByTree.get(treeKey) : undefined;
  const cachedOrdinal = cachedByTree?.get(node.startIndex);
  if (cachedOrdinal !== undefined) return `@anon${cachedOrdinal}`;

  const parent = node.parent;
  let ordinal = 1;
  if (parent) {
    let treeMap = cachedByTree;
    if (treeKey && !treeMap) {
      treeMap = new Map<number, number>();
      anonNsOrdinalByTree.set(treeKey, treeMap);
    }
    let seen = 0;
    const count = parent.namedChildCount;
    if (typeof count === 'number' && typeof parent.namedChild === 'function') {
      for (let i = 0; i < count; i++) {
        const sibling = parent.namedChild(i);
        if (sibling?.type === 'namespace_definition' && !sibling.childForFieldName?.('name')) {
          seen += 1;
          treeMap?.set(sibling.startIndex, seen);
          if (sibling.startIndex === node.startIndex) ordinal = seen;
        }
      }
    } else if (parent.namedChildren) {
      for (const sibling of parent.namedChildren) {
        if (sibling?.type === 'namespace_definition' && !sibling.childForFieldName?.('name')) {
          seen += 1;
          treeMap?.set(sibling.startIndex, seen);
          if (sibling.startIndex === node.startIndex) ordinal = seen;
        }
      }
    }
  }
  return `@anon${ordinal}`;
};

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
  qualifiedMemberIds: true,
  // #1995: anonymous namespaces have no `name` child, so the generic scope walker
  // drops them (empty segment) and two `namespace { struct Inner {} }` blocks in one
  // TU collapse onto a single `Inner` node. Give each anonymous namespace_definition
  // a deterministic per-block discriminator (its start byte — stable across the
  // sequential and worker full-file parses) so the nested types stay distinct.
  // Returning `undefined` for every other scope — named namespaces (incl. `inline
  // namespace`), classes, structs, named unions — falls through to the default
  // name-based extraction, leaving them unchanged. Anonymous UNIONS are not matched
  // here (members inject into the enclosing scope), so they keep yielding [].
  extractScopeSegments: (node) =>
    node.type === 'namespace_definition' && !node.childForFieldName?.('name')
      ? [cppAnonymousNamespaceSegment(node)]
      : undefined,
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
