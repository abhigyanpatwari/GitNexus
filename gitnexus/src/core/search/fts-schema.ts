export interface FTSIndexDefinition {
  readonly table: string;
  readonly indexName: string;
  readonly properties: readonly string[];
}

export const FTS_INDEXES: readonly FTSIndexDefinition[] = [
  { table: 'File', indexName: 'file_fts', properties: ['name', 'content'] },
  { table: 'Function', indexName: 'function_fts', properties: ['name', 'content'] },
  { table: 'Class', indexName: 'class_fts', properties: ['name', 'content'] },
  { table: 'Method', indexName: 'method_fts', properties: ['name', 'content'] },
  { table: 'Interface', indexName: 'interface_fts', properties: ['name', 'content'] },
];
