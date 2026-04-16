// gitnexus/src/core/ingestion/class-extractors/configs/typescript-javascript.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

const shared: Omit<ClassExtractionConfig, 'language'> = {
  typeDeclarationNodes: [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'enum_declaration',
  ],
  ancestorScopeNodeTypes: [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'enum_declaration',
  ],
};

export const typescriptClassConfig: ClassExtractionConfig = {
  ...shared,
  language: SupportedLanguages.TypeScript,
};

export const javascriptClassConfig: ClassExtractionConfig = {
  ...shared,
  language: SupportedLanguages.JavaScript,
};

export const vueClassConfig: ClassExtractionConfig = {
  ...shared,
  language: SupportedLanguages.Vue,
};
