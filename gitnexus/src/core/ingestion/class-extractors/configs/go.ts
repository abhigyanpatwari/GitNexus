// gitnexus/src/core/ingestion/class-extractors/configs/go.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

export const goClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Go,
  typeDeclarationNodes: ['type_declaration'],
  fileScopeNodeTypes: ['package_clause'],
  extractName(node) {
    const typeSpec = node.namedChildren.find((child) => child.type === 'type_spec');
    return typeSpec?.childForFieldName('name')?.text;
  },
  extractType(node) {
    const typeSpec = node.namedChildren.find((child) => child.type === 'type_spec');
    const typeNode = typeSpec?.childForFieldName('type');
    if (typeNode?.type === 'struct_type') return 'Struct';
    if (typeNode?.type === 'interface_type') return 'Interface';
    return undefined;
  },
};
