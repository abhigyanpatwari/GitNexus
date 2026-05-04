import { createFTSIndex } from '../lbug/lbug-adapter.js';
import { FTS_INDEXES } from './fts-schema.js';

export async function createSearchFTSIndexes(): Promise<void> {
  for (const { table, indexName, properties } of FTS_INDEXES) {
    await createFTSIndex(table, indexName, [...properties]);
  }
}
