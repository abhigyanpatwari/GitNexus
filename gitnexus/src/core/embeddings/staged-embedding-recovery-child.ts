/** Isolated strict native reader. Never import this entrypoint into analyze. */
import fs from 'node:fs';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { createLbugDatabase, toNativeSafePath } from '../lbug/lbug-config.js';
import {
  abortCachedEmbeddingsBuilder,
  createCachedEmbeddingsBuilder,
  finalizeCachedEmbeddingsSnapshot,
  ingestCachedEmbeddingRow,
} from './embedding-restore-spill.js';
import type { StagedEmbeddingExport } from './staged-embedding-recovery.js';

async function extract(): Promise<void> {
  const [dbPath, exportDir, dimensionsArg] = process.argv.slice(2);
  const dimensions = Number(dimensionsArg);
  if (!dbPath || !exportDir || !Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error('invalid staged embedding extraction arguments');
  }
  const stat = fs.lstatSync(dbPath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('staged embedding DB is not a regular file');
  const builder = createCachedEmbeddingsBuilder({ inMemoryRowLimit: 0, spillDir: exportDir });
  const rejectedNodeIds = new Set<string>();
  // Avoid openLbugConnection's test-fixture lock sweep: a recovery source must
  // never have its WAL removed, even when an external slot resembles a fixture.
  const db = createLbugDatabase(lbug, toNativeSafePath(dbPath), { throwOnWalReplayFailure: true });
  const handle = { db, conn: new lbug.Connection(db) };
  try {
    const queried = await handle.conn.query(
      'MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding, e.contentHash AS contentHash',
    );
    const results = Array.isArray(queried) ? queried : [queried];
    try {
      if (results.length !== 1) throw new Error('unexpected staged embedding query result');
      const result = results[0];
      while (await result.hasNext()) {
        const raw = await result.getNext();
        const rec = raw as Record<string, unknown> & unknown[];
        const nodeId = rec.nodeId ?? rec[0];
        if (typeof nodeId !== 'string' || !nodeId)
          throw new Error('invalid staged embedding node id');
        const chunkIndex = rec.chunkIndex ?? rec[1];
        const startLine = rec.startLine ?? rec[2];
        const endLine = rec.endLine ?? rec[3];
        const embedding = rec.embedding ?? rec[4];
        const contentHash = rec.contentHash ?? rec[5];
        const vector =
          Array.isArray(embedding) ||
          (ArrayBuffer.isView(embedding) && !(embedding instanceof DataView))
            ? Array.from(embedding as ArrayLike<number>)
            : undefined;
        if (
          !Number.isInteger(chunkIndex) ||
          Number(chunkIndex) < 0 ||
          !Number.isInteger(startLine) ||
          Number(startLine) < 0 ||
          !Number.isInteger(endLine) ||
          Number(endLine) < Number(startLine) ||
          typeof contentHash !== 'string' ||
          !contentHash ||
          !vector ||
          vector.length !== dimensions ||
          vector.some(
            (value) =>
              typeof value !== 'number' ||
              !Number.isFinite(value) ||
              !Number.isFinite(Math.fround(value)),
          )
        ) {
          rejectedNodeIds.add(nodeId);
          continue;
        }
        ingestCachedEmbeddingRow(
          builder,
          { nodeId, chunkIndex, startLine, endLine, embedding: vector, contentHash },
          true,
        );
      }
    } finally {
      for (const result of results) await result.close();
    }
    // Both closes must succeed. Suppressed native teardown errors are unsafe.
    await handle.conn.close();
    await handle.db.close();
    const snapshot = finalizeCachedEmbeddingsSnapshot(builder);
    if (snapshot.spill) fs.renameSync(snapshot.spill.path, path.join(exportDir, 'vectors.bin'));
    const manifest: StagedEmbeddingExport = {
      version: 1,
      dimensions,
      rows: snapshot.rows,
      rejectedNodeIds: [...rejectedNodeIds],
    };
    fs.writeFileSync(path.join(exportDir, 'manifest.json'), JSON.stringify(manifest), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (err) {
    abortCachedEmbeddingsBuilder(builder);
    // Cleanup is best effort on a rejected source, never used to approve output.
    try {
      await handle.conn.close();
    } catch {
      /* rejected */
    }
    try {
      await handle.db.close();
    } catch {
      /* rejected */
    }
    throw err;
  }
}

extract().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
