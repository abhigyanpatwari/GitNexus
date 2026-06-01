// gitnexus/src/core/ingestion/heritage-extractors/configs/javascript.ts

import type { SupertypeShapeDescriptor } from '../../heritage-types.js';

/**
 * JavaScript supertype shapes.
 *
 * `class_heritage` directly holds the parent expression: a bare `identifier`
 * or a `member_expression` (qualified `ns.Base`).
 */
export const javascriptHeritageShapes: SupertypeShapeDescriptor = {
  shapes: ['identifier', 'member_expression'],
};
