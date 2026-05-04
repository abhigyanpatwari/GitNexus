export interface FTSIndexDefinition {
  readonly table: string;
  readonly indexName: string;
  readonly properties: readonly string[];
}

export const FTS_INDEXES: readonly FTSIndexDefinition[] = [
  { table: 'File', indexName: 'file_fts', properties: ['name', 'content'] },
  { table: 'Function', indexName: 'function_fts', properties: ['name', 'content', 'description'] },
  { table: 'Class', indexName: 'class_fts', properties: ['name', 'content', 'description'] },
  { table: 'Method', indexName: 'method_fts', properties: ['name', 'content', 'description'] },
  {
    table: 'Interface',
    indexName: 'interface_fts',
    properties: ['name', 'content', 'description'],
  },
];
