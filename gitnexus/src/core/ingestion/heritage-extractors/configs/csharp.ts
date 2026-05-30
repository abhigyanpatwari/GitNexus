// gitnexus/src/core/ingestion/heritage-extractors/configs/csharp.ts

import type { SupertypeShapeDescriptor } from '../../heritage-types.js';

/**
 * C# base-list supertype shapes.
 *
 * Every `base_list` entry (class/record/struct) is captured as
 * `@heritage.extends`; EXTENDS-vs-IMPLEMENTS is decided downstream by
 * `resolveExtendsType`, so the query does not pre-split. Entries can be a bare
 * `identifier`, a `generic_name` (`IFoo<T>`), a `qualified_name` (`ns.Base`),
 * a `scoped_type` (alias-qualified), or a `primary_constructor_base_type`
 * (`Base(args)` on a record).
 */
export const csharpHeritageShapes: SupertypeShapeDescriptor = {
  shapes: [
    'identifier',
    'generic_name',
    'qualified_name',
    'scoped_type',
    'primary_constructor_base_type',
  ],
};
