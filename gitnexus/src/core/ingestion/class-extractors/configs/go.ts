// gitnexus/src/core/ingestion/class-extractors/configs/go.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

export const goClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Go,
  // `type_spec`, not the enclosing `type_declaration` (#2837): one node per
  // DECLARED TYPE, so a grouped `type ( A struct{…}; B struct{…} )` yields one
  // each instead of one for the whole block. Every Go capture that reaches this
  // extractor is anchored the same way, so the wrapper is never handed over —
  // and accepting it would be worse than rejecting it, because picking one spec
  // out of several with no reference point silently returns the FIRST type's
  // name. A `null` here is loud; the wrong name is not.
  typeDeclarationNodes: ['type_spec'],
  fileScopeNodeTypes: ['package_clause'],
  extractName(node) {
    return node.childForFieldName('name')?.text;
  },
  extractType(node) {
    const typeNode = node.childForFieldName('type');
    if (typeNode?.type === 'struct_type') return 'Struct';
    if (typeNode?.type === 'interface_type') return 'Interface';
    return undefined;
  },
};
