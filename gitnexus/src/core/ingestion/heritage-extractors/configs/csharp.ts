// gitnexus/src/core/ingestion/heritage-extractors/configs/csharp.ts

import type { SupertypeShapeDescriptor } from '../../heritage-types.js';

/**
 * C# base-list supertype shapes.
 *
 * Every `base_list` entry (class/record/struct/interface) is captured as
 * `@heritage.extends`; EXTENDS-vs-IMPLEMENTS is decided downstream by
 * `resolveExtendsType`, so the query does not pre-split. Entries can be a bare
 * `identifier`, a `generic_name` (`IFoo<T>`), a `qualified_name` (`ns.Base`,
 * and also `global::System.IDisposable` — a dotted name qualified by an
 * `alias_qualified_name` parses as a `qualified_name` whose first part is the
 * alias), an `alias_qualified_name` (a *bare* alias-qualified base with no
 * dotted suffix: `global::IDisposable`, `MyAlias::Foo`), or a
 * `primary_constructor_base_type` (`Base(args)` on a record).
 *
 * NOTE: `scoped_type` is intentionally NOT listed. Per
 * tree-sitter-c-sharp/src/node-types.json, `scoped_type` is a `type` subtype
 * that wraps a `ref_type` (the `scoped ref`/`scoped in` parameter modifier);
 * it is referenced only by the hidden `type` supertype and never appears as a
 * `base_list` entry, so adding it would be a dead, untested shape. The
 * alias-qualified base shapes that *do* occur are `qualified_name` (dotted) and
 * `alias_qualified_name` (bare) — verified by parsing
 * `class A : System.Exception, global::System.IDisposable, MyAlias::Foo {}`.
 * `normalizeSupertypeName` collapses `alias_qualified_name` to the simple name
 * via its `name` field (an `identifier`). See
 * `test/integration/heritage-supertype-shapes.test.ts`.
 */
export const csharpHeritageShapes: SupertypeShapeDescriptor = {
  shapes: [
    'identifier',
    'generic_name',
    'qualified_name',
    'alias_qualified_name',
    'primary_constructor_base_type',
  ],
};
