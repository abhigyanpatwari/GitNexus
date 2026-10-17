import fs from 'node:fs/promises';
import lbug from '@ladybugdb/core';

const [dbPath, mode] = process.argv.slice(2);
const db = new lbug.Database(dbPath, 256 * 1024 * 1024, false, false, 1024 ** 3);
const conn = new lbug.Connection(db);
async function query(cypher) {
  const result = await conn.query(cypher);
  for (const cursor of Array.isArray(result) ? result : [result]) {
    try {
      await cursor.getAll();
    } finally {
      await cursor.close();
    }
  }
}
await query('CHECKPOINT');
await query(
  "CREATE (:Function {id: 'Function:wal.ts:walOnly', name: 'walOnly', filePath: 'wal.ts', startLine: 1, endLine: 1})",
);
const main = await fs.readFile(dbPath);
const wal = await fs.readFile(`${dbPath}.wal`);
await conn.close();
await db.close();
// Restore real committed WAL bytes to simulate interruption before consolidation.
await fs.writeFile(dbPath, main);
if (mode === 'checkpoint') {
  await fs.writeFile(`${dbPath}.wal.checkpoint`, wal);
  for (const suffix of ['.wal', '.shadow', '.checkpoint.intent.lock', '.checkpoint.apply.lock']) {
    await fs.writeFile(`${dbPath}${suffix}`, '');
  }
} else {
  await fs.writeFile(`${dbPath}.wal`, wal);
}
