// gitnexus/src/core/ingestion/class-extractors/configs/c-cpp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';
import {
  extractTemplateArguments,
  stripTemplateArguments,
} from '../../utils/template-arguments.js';

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
  ancestorScopeNodeTypes: ['namespace_definition', 'class_specifier', 'struct_specifier'],
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
