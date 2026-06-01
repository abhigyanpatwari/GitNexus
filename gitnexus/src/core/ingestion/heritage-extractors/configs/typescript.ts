// gitnexus/src/core/ingestion/heritage-extractors/configs/typescript.ts

import type { SupertypeShapeDescriptor } from '../../heritage-types.js';

/**
 * TypeScript supertype shapes.
 *
 * The class `extends_clause` value is an expression — `identifier` or
 * `member_expression` (qualified `ns.Base`); generics ride a separate
 * `type_arguments` field, so there is no `generic_type` here. The class
 * `implements_clause` and the `interface_declaration → extends_type_clause`
 * use type-space nodes: `type_identifier`, `generic_type`, and
 * `nested_type_identifier` (`ns.Base`).
 */

/** Shapes valid in a class `extends_clause` value position. */
export const typescriptExtendsShapes: SupertypeShapeDescriptor = {
  shapes: ['identifier', 'member_expression'],
};

/** Shapes valid in `implements_clause` / interface `extends_type_clause`. */
export const typescriptInterfaceShapes: SupertypeShapeDescriptor = {
  shapes: ['type_identifier', 'generic_type', 'nested_type_identifier'],
};
