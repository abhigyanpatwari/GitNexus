// gitnexus/src/core/ingestion/class-extractors/configs/c-cpp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';
import {
  extractTemplateArguments,
  stripTemplateArguments,
} from '../../utils/template-arguments.js';

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
};
