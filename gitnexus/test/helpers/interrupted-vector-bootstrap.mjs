// Exit after native DDL returns to JS, before the artifact identity is written.
// The parent reopens the real file; no storage or recovery implementation is mocked.
import lbug from '@ladybugdb/core';
import { VectorStore } from '../../dist/core/lbug/vector-store.js';

const query = lbug.Connection.prototype.query;
lbug.Connection.prototype.query = async function (sql, ...args) {
  const result = await query.call(this, sql, ...args);
  if (sql.startsWith('CREATE NODE TABLE CodeEmbedding')) process.exit(73);
  return result;
};
await VectorStore.open(JSON.parse(process.argv[2]));
throw new Error('Expected interruption during vector schema creation');
