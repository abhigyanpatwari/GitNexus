// gitnexus/src/core/ingestion/class-extractors/configs/csharp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

export const csharpClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.CSharp,
  typeDeclarationNodes: [
    'class_declaration',
    'interface_declaration',
    'struct_declaration',
    'enum_declaration',
    'record_declaration',
  ],
  fileScopeNodeTypes: ['file_scoped_namespace_declaration'],
  ancestorScopeNodeTypes: [
    'namespace_declaration',
    'class_declaration',
    'interface_declaration',
    'struct_declaration',
    'enum_declaration',
    'record_declaration',
  ],
};
