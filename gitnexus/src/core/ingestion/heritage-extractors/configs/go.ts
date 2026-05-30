// gitnexus/src/core/ingestion/heritage-extractors/configs/go.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig, SupertypeShapeDescriptor } from '../../heritage-types.js';

/**
 * Go embed supertype shapes.
 *
 * Struct embedding (anonymous `field_declaration` type) and interface-in-
 * interface embedding (`interface_type → type_elem`) can both name a bare
 * `type_identifier`, a `qualified_type` (`pkg.Base`), or a `generic_type`
 * (`Gen[T]`). Named struct fields also match the field pattern and are
 * filtered out at runtime by {@link goHeritageConfig.shouldSkipExtends}.
 */
export const goHeritageShapes: SupertypeShapeDescriptor = {
  shapes: ['type_identifier', 'qualified_type', 'generic_type'],
};

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
