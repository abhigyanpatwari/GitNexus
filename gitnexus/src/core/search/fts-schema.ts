export interface FTSIndexDefinition {
  readonly table: string;
  readonly indexName: string;
  readonly properties: readonly string[];
}

// Shared by both index creation (`createSearchFTSIndexes`) and querying
// (`searchFTSFromLbug` / `verifySearchFTSIndexes`) — the single source of truth
// for which tables/columns are full-text searchable. Adding `description` here
// makes doc comments (Javadoc/KDoc/JSDoc/Doxygen/godoc/RDoc) keyword-searchable
// once they are populated by `descriptionExtractor` (#2270/#2286, issue #2299).
//
// IMPORTANT: every property must be a real column on its table (see
// `core/lbug/schema.ts`). `File` has no `description` column, so it stays
// name+content. All other entries below carry a `description` column.
//
// Tables beyond the original 5 mirror `EMBEDDABLE_LABELS` (embeddings/types.ts):
// indexing the same set keeps a symbol's doc comment both keyword- and
// semantically-searchable.
const FTS_PROPERTIES = ['name', 'content', 'description'] as const;

export const FTS_INDEXES: readonly FTSIndexDefinition[] = [
  // File has no `description` column — keep it name+content only.
  { table: 'File', indexName: 'file_fts', properties: ['name', 'content'] },
  // Original 5 (minus File) gain `description`.
  { table: 'Function', indexName: 'function_fts', properties: FTS_PROPERTIES },
  { table: 'Class', indexName: 'class_fts', properties: FTS_PROPERTIES },
  { table: 'Method', indexName: 'method_fts', properties: FTS_PROPERTIES },
  { table: 'Interface', indexName: 'interface_fts', properties: FTS_PROPERTIES },
  // Remaining EMBEDDABLE_LABELS symbol tables — all CODE_ELEMENT_BASE-shaped
  // (or a superset), so all carry name + content + description columns.
  { table: 'Constructor', indexName: 'constructor_fts', properties: FTS_PROPERTIES },
  { table: 'Struct', indexName: 'struct_fts', properties: FTS_PROPERTIES },
  { table: 'Enum', indexName: 'enum_fts', properties: FTS_PROPERTIES },
  { table: 'Trait', indexName: 'trait_fts', properties: FTS_PROPERTIES },
  { table: 'Impl', indexName: 'impl_fts', properties: FTS_PROPERTIES },
  { table: 'Macro', indexName: 'macro_fts', properties: FTS_PROPERTIES },
  { table: 'Namespace', indexName: 'namespace_fts', properties: FTS_PROPERTIES },
  { table: 'TypeAlias', indexName: 'type_alias_fts', properties: FTS_PROPERTIES },
  { table: 'Typedef', indexName: 'typedef_fts', properties: FTS_PROPERTIES },
  { table: 'Const', indexName: 'const_fts', properties: FTS_PROPERTIES },
  { table: 'Property', indexName: 'property_fts', properties: FTS_PROPERTIES },
  { table: 'Record', indexName: 'record_fts', properties: FTS_PROPERTIES },
  { table: 'Union', indexName: 'union_fts', properties: FTS_PROPERTIES },
  { table: 'Static', indexName: 'static_fts', properties: FTS_PROPERTIES },
  { table: 'Variable', indexName: 'variable_fts', properties: FTS_PROPERTIES },
];
