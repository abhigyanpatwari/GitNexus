// gitnexus/src/core/ingestion/heritage-extractors/configs/go.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig } from '../../heritage-types.js';

/**
 * Go heritage extraction config.
 *
 * Go struct embedding: the tree-sitter query matches ALL field_declarations
 * with type_identifier, but only anonymous fields (no name) are embedded.
 * Named fields like `Breed string` also match — skip them.
 *
 * The shouldSkipExtends hook checks if the extends node's parent is a
 * field_declaration with a named field child, indicating a regular
 * (non-embedded) field that should not produce a heritage record.
 */
export const goHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.Go,

  shouldSkipExtends(extendsNode) {
    const fieldDecl = extendsNode.parent;
    return fieldDecl?.type === 'field_declaration' && fieldDecl.childForFieldName?.('name') != null;
  },
};
