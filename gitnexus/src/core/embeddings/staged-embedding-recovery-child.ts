/** Isolated strict native reader. Never import this entrypoint into analyze. */
import fs from 'node:fs';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { createLbugDatabase, toNativeSafePath } from '../lbug/lbug-config.js';
import { FAMILY_SUFFIXES } from '../../storage/embedding-recovery.js';
import {
  abortCachedEmbeddingsBuilder,
  createCachedEmbeddingsBuilder,
  finalizeCachedEmbeddingsSnapshot,
  ingestCachedEmbeddingRow,
} from './embedding-restore-spill.js';
import type { StagedEmbeddingExport } from './staged-embedding-recovery.js';

/** Native replay and close may checkpoint; only give them disposable copies. */
function copyRecoveryFamily(dbPath: string, exportDir: string): string {
  const replayDir = fs.mkdtempSync(path.join(exportDir, 'replay-'));
  const replayPath = path.join(replayDir, path.basename(dbPath));
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const flags = fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (const suffix of FAMILY_SUFFIXES) {
    const sourcePath = dbPath + suffix;
    let entry: fs.BigIntStats;
    try {
      entry = fs.lstatSync(sourcePath, { bigint: true });
    } catch (error) {
      if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!entry.isFile()) throw new Error('staged embedding family is not a regular file');
    const source = fs.openSync(sourcePath, flags);
    let destination: number | undefined;
    try {
      const opened = fs.fstatSync(source, { bigint: true });
      const current = fs.lstatSync(sourcePath, { bigint: true });
      if (
        !opened.isFile() ||
        !current.isFile() ||
        (noFollow === 0 && opened.ino === 0n) ||
        opened.dev !== entry.dev ||
        opened.ino !== entry.ino ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      ) {
        throw new Error('staged embedding family changed while opening');
      }
      destination = fs.openSync(replayPath + suffix, 'wx', 0o600);
      let copied = 0n;
      for (;;) {
        const bytesRead = fs.readSync(source, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        fs.writeFileSync(destination, buffer.subarray(0, bytesRead));
        copied += BigInt(bytesRead);
      }
      const after = fs.fstatSync(source, { bigint: true });
      if (
        copied !== opened.size ||
        after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs
      ) {
        throw new Error('staged embedding family changed while copying');
      }
    } finally {
      try {
        if (destination !== undefined) fs.closeSync(destination);
      } finally {
        fs.closeSync(source);
      }
    }
  }
  return replayPath;
}

async function extract(): Promise<void> {
  const [dbPath, exportDir, dimensionsArg] = process.argv.slice(2);
  const dimensions = Number(dimensionsArg);
  if (!dbPath || !exportDir || !Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error('invalid staged embedding extraction arguments');
  }
  // The parent owns exportDir and reclaims it even after killing this child.
  const replayPath = copyRecoveryFamily(dbPath, exportDir);
  const builder = createCachedEmbeddingsBuilder({ inMemoryRowLimit: 0, spillDir: exportDir });
  const rejectedNodeIds = new Set<string>();
  let db: lbug.Database | undefined;
  let conn: lbug.Connection | undefined;
  try {
    // Avoid openLbugConnection's test-fixture lock sweep: a recovery source must
    // never have its WAL removed, even when an external slot resembles a fixture.
    db = createLbugDatabase(lbug, toNativeSafePath(replayPath), { throwOnWalReplayFailure: true });
    conn = new lbug.Connection(db);
    const queried = await conn.query(
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
    await conn.close();
    await db.close();
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
      await conn?.close();
    } catch {
      /* rejected */
    }
    try {
      await db?.close();
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
