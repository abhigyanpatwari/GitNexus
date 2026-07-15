// gitnexus/src/core/ingestion/class-extractors/configs/solidity.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

export const solidityClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Solidity,
  typeDeclarationNodes: [
    'contract_declaration',
    'interface_declaration',
    'library_declaration',
    'struct_declaration',
    'enum_declaration',
    'error_declaration',
    'event_definition',
  ],
  ancestorScopeNodeTypes: [
    'contract_declaration',
    'interface_declaration',
    'library_declaration',
  ],
};
