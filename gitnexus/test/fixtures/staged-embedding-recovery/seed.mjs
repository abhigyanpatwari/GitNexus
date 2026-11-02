import lbug from '@ladybugdb/core';
import fs from 'node:fs';
import { createLbugDatabase } from '../../../src/core/lbug/lbug-config.ts';

const [dbPath, mode] = process.argv.slice(2);
const db = createLbugDatabase(lbug, dbPath);
const conn = new lbug.Connection(db);
async function query(cypher) {
  const queried = await conn.query(cypher);
  for (const result of Array.isArray(queried) ? queried : [queried]) {
    await result.getAll();
    await result.close();
  }
}
await query('CREATE NODE TABLE CodeEmbedding (id STRING, nodeId STRING, chunkIndex INT32, startLine INT64, endLine INT64, embedding FLOAT[2], contentHash STRING, PRIMARY KEY(id))');
async function row(id, nodeId, chunkIndex, hash = 'same', startLine = 1, endLine = 3) {
  await query(`CREATE (:CodeEmbedding {id: '${id}', nodeId: '${nodeId}', chunkIndex: ${chunkIndex}, startLine: ${startLine}, endLine: ${endLine}, embedding: [1.0, 2.0], contentHash: ${hash === null ? 'NULL' : `'${hash}'`}})`);
}
await row('complete-0', 'complete', 0);
await row('complete-1', 'complete', 1);
await row('other', 'other', 0);
await query('CHECKPOINT');
if (mode === 'interrupted-checkpoint') {
  await row('checkpoint-only', 'checkpoint-only', 0);
  const main = fs.readFileSync(dbPath);
  const wal = fs.readFileSync(`${dbPath}.wal`);
  await conn.close();
  await db.close();
  // Restore the pre-close bytes: writable close has already checkpointed them.
  fs.writeFileSync(dbPath, main);
  fs.writeFileSync(`${dbPath}.wal.checkpoint`, wal);
  fs.writeFileSync(`${dbPath}.wal`, '');
  fs.writeFileSync(`${dbPath}.shadow`, '');
  fs.writeFileSync(`${dbPath}.checkpoint.intent.lock`, '');
  fs.writeFileSync(`${dbPath}.checkpoint.apply.lock`, '');
} else if (mode === 'hard-kill') {
  await row('unsafe', 'unsafe-prefix', 0);
  process.kill(process.pid, 'SIGKILL');
} else {
  await row('gap', 'gap', 1);
  await row('duplicate-0', 'duplicate', 0);
  await row('duplicate-1', 'duplicate', 0);
  await row('mixed-0', 'mixed', 0, 'old');
  await row('mixed-1', 'mixed', 1, 'new');
  await row('missing-hash-0', 'missing-hash', 0);
  await row('missing-hash-1', 'missing-hash', 1, null);
  await row('bad-line', 'bad-line', 0, 'same', -1, 3);
  await row('nan-0', 'nan', 0);
  await query("CREATE (:CodeEmbedding {id: 'nan-1', nodeId: 'nan', chunkIndex: 1, startLine: 1, endLine: 3, embedding: [CAST('NaN', 'FLOAT'), 2.0], contentHash: 'same'})");
  await conn.close();
  await db.close();
}
