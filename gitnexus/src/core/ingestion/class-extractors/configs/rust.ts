// gitnexus/src/core/ingestion/class-extractors/configs/rust.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

export const rustClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Rust,
  typeDeclarationNodes: ['struct_item', 'enum_item'],
  ancestorScopeNodeTypes: ['mod_item', 'struct_item', 'enum_item'],
};
