// gitnexus/src/core/ingestion/heritage-extractors/configs/cpp.ts

import type { SupertypeShapeDescriptor } from '../../heritage-types.js';

/**
 * C++ base-class supertype shapes (legacy CPP_QUERIES bank only).
 *
 * A `base_class_clause` entry can be a bare `type_identifier`, a
 * `template_type` (`Base<T>`), or a `qualified_identifier` (`ns::Base`,
 * possibly itself wrapping a `template_type`). Entries may be prefixed by an
 * `access_specifier`; tree-sitter's bracketed alternation matches the base
 * node regardless of the preceding access specifier, so a single pattern
 * covers both `: Base` and `: public Base`.
 *
 * NOTE: the registry/scope-resolution path emits its own normalized
 * `@reference.inherits` captures (see languages/cpp/captures.ts); this
 * descriptor only repairs the legacy heritage-query bank.
 */
export const cppHeritageShapes: SupertypeShapeDescriptor = {
  shapes: ['type_identifier', 'template_type', 'qualified_identifier'],
};
