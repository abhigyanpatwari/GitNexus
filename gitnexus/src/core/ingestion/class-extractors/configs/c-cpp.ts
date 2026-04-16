// gitnexus/src/core/ingestion/class-extractors/configs/c-cpp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

export const cClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.C,
  typeDeclarationNodes: ['struct_specifier', 'enum_specifier'],
};

export const cppClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,
  typeDeclarationNodes: ['class_specifier', 'struct_specifier', 'enum_specifier'],
  ancestorScopeNodeTypes: ['namespace_definition', 'class_specifier', 'struct_specifier'],
};
