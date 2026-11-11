import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { afterEach, expect, it, vi } from 'vitest';
import { exportLegacyVectors } from '../../src/core/lbug/legacy-vector-export.js';
import { openLbugConnection, closeLbugConnection } from '../../src/core/lbug/lbug-config.js';
import { LegacyVectorSource } from '../../src/core/lbug/legacy-vector-source.js';
import { VectorStore } from '../../src/core/lbug/vector-store.js';
import { readLegacyEmbeddingSource } from '../../src/storage/legacy-embedding-source.js';
import { contentHashForNode } from '../../src/core/embeddings/embedding-pipeline.js';
import { resolveEmbeddingConfig } from '../../src/core/embeddings/config.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';

const roots: string[] = [];
const pool = 32 * 1024 * 1024;
const identity = { provider: 'local', model: 'historical-model', dimensions: 4 };
const config = resolveEmbeddingConfig({ threads: 1 });
const node: EmbeddableNode = {
  id: 'Const:a.ts:value',
  name: 'value',
  label: 'Const',
  filePath: 'a.ts',
  content: 'const value = 1;',
  startLine: 1,
  endLine: 1,
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(rows = 1, prefix = "gn-legacy-export-'") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const file = path.join(root, 'lbug');
  const handle = await openLbugConnection(lbug, file, { bufferPoolBytes: pool, threads: 1 });
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    const result = await handle.conn.query(sql);
    const cursors = Array.isArray(result) ? result : [result];
    try {
      return await cursors[0].getAll();
    } finally {
      for (const cursor of cursors) cursor.close();
    }
  };
  await query(
    'CREATE NODE TABLE CodeEmbedding (id STRING, nodeId STRING, chunkIndex INT32, startLine INT64, endLine INT64, embedding FLOAT[4], contentHash STRING, PRIMARY KEY(id))',
  );
  await query('CREATE NODE TABLE File (id STRING, content STRING, PRIMARY KEY(id))');
  await query(
    "CREATE (:File {id:'File:a.ts',content:'Graph content must stay out of the export'})",
  );
  const hash = contentHashForNode(node, config);
  if (rows)
    await query(
      `UNWIND range(0, ${rows - 1}) AS i CREATE (:CodeEmbedding {id:'Const:a.ts:value:' + CAST(i AS STRING),nodeId:'Const:a.ts:value',chunkIndex:i,startLine:1,endLine:1,embedding:[1,0,0,0],contentHash:'${hash}'})`,
    );
  await query('CHECKPOINT');
  const options = {
    metadataDirectory: root,
    query,
    provenance: { schemaFingerprint: 'schema', recordedIdentity: identity },
    excluded: [] as string[],
    bufferPoolBytes: pool,
    threads: 1,
  };
  return {
    root,
    file,
    query,
    hash,
    options,
    close: () => closeLbugConnection(handle, { strict: true, databasePath: file }),
  };
}

it.each(["gn-legacy-export-'", "gn-legacy-export-路径-'"])(
  'exports a reusable vector table under %s without provider work',
  async (prefix) => {
    const f = await fixture(1, prefix);
    const before = await fs.stat(f.file, { bigint: true });
    const copy = vi.spyOn(fs, 'copyFile');
    let store: VectorStore | undefined, source: LegacyVectorSource | undefined;
    try {
      const id = await exportLegacyVectors(f.options);
      expect(id).toMatch(/^[a-f0-9]{64}$/);
      const receipt = await readLegacyEmbeddingSource(f.root, id!);
      expect(receipt.recordedIdentity).toEqual(identity);
      expect(copy).not.toHaveBeenCalled();
      expect((await fs.stat(f.file, { bigint: true })).ino).toBe(before.ino);
      expect(await f.query('MATCH (n:File) RETURN n.content AS content')).toEqual([
        { content: 'Graph content must stay out of the export' },
      ]);
      const exported = await openLbugConnection(lbug, receipt.path, {
        readOnly: true,
        bufferPoolBytes: pool,
        threads: 1,
      });
      try {
        const result = await exported.conn.query('CALL show_tables() RETURN name');
        const cursor = Array.isArray(result) ? result[0] : result;
        try {
          expect(await cursor.getAll()).toEqual([{ name: 'CodeEmbedding' }]);
        } finally {
          cursor.close();
        }
      } finally {
        await closeLbugConnection(exported, { strict: true, databasePath: receipt.path });
      }
      await fs.mkdir(path.join(f.root, 'reuse'));
      store = await VectorStore.open({
        directory: path.join(f.root, 'reuse'),
        identity: 'b'.repeat(64),
        dimensions: 4,
        mode: 'create',
        bufferPoolBytes: pool,
        threads: 1,
        batchBytes: 65536,
      });
      source = await LegacyVectorSource.open(
        {
          path: receipt.path,
          sourceIdentity: receipt.identity,
          recordedIdentity: receipt.recordedIdentity,
          expectedIdentity: identity,
          expectedInputIdentity: 'c'.repeat(64),
          config,
          bufferPoolBytes: pool,
          threads: 1,
          batchBytes: 65536,
        },
        store,
        receipt.excludedIds,
      );
      const group = await source.reusable(node.id, f.hash, { node });
      expect(group?.chunks).toBe(1);
      expect(await source.readChunks(group!, 0, 1)).toEqual([
        { chunkIndex: 0, startLine: 1, endLine: 1, embedding: [1, 0, 0, 0] },
      ]);
    } finally {
      await source?.close();
      await store?.close();
      await f.close();
    }
  },
);

it('keeps vector payloads out of JavaScript while transferring a larger table', async () => {
  const f = await fixture(4096);
  let largestResult = 0;
  try {
    const id = await exportLegacyVectors({
      ...f.options,
      query: async (sql) => {
        const rows = await f.query(sql);
        largestResult = Math.max(largestResult, rows.length);
        expect(rows.every((row) => !Object.hasOwn(row, 'embedding'))).toBe(true);
        return rows;
      },
    });
    expect(id).toBeDefined();
    expect(largestResult).toBe(7);
    expect(await f.query('MATCH (e:CodeEmbedding) RETURN count(e) AS count')).toEqual([
      { count: 4096 },
    ]);
  } finally {
    await f.close();
  }
});

it('does not invent missing historical provider or input provenance', async () => {
  const f = await fixture();
  try {
    const id = await exportLegacyVectors({
      ...f.options,
      provenance: { schemaFingerprint: 'schema' },
      excluded: [node.id],
    });
    const receipt = await readLegacyEmbeddingSource(f.root, id!);
    expect(receipt.recordedIdentity).toBeUndefined();
    expect(receipt.recordedInputIdentity).toBeUndefined();
    const ids = [];
    for await (const id of receipt.excludedIds()) ids.push(id);
    expect(ids).toEqual([node.id]);
  } finally {
    await f.close();
  }
});

it('does not create an artifact for an empty vector table', async () => {
  const f = await fixture(0);
  try {
    expect(await exportLegacyVectors(f.options)).toBeUndefined();
    expect(
      (await fs.readdir(f.root)).filter((name) => name.startsWith('lbug.generation.')),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

it('rejects mismatched historical dimensions before exporting', async () => {
  const f = await fixture();
  try {
    await expect(
      exportLegacyVectors({
        ...f.options,
        provenance: {
          schemaFingerprint: 'schema',
          recordedIdentity: { ...identity, dimensions: 8 },
        },
      }),
    ).rejects.toThrow('schema differs');
    expect(
      (await fs.readdir(f.root)).filter((name) => name.startsWith('lbug.generation.')),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

it('refuses publication when the source count changes during the transfer', async () => {
  const f = await fixture();
  let counts = 0;
  try {
    await expect(
      exportLegacyVectors({
        ...f.options,
        query: async (sql) => {
          if (sql.includes('count(e)') && ++counts === 2) return [{ count: 2 }];
          return f.query(sql);
        },
      }),
    ).rejects.toThrow('source changed');
    expect((await fs.readdir(f.root)).filter((name) => /generation|staging/.test(name))).toEqual(
      [],
    );
    expect((await f.query('MATCH (e:CodeEmbedding) RETURN count(e) AS count'))[0].count).toBe(1);
  } finally {
    await f.close();
  }
});

it('cancels after the native export returns without publishing or mutating its source', async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    await expect(
      exportLegacyVectors({
        ...f.options,
        signal: abort.signal,
        query: async (sql) => {
          const result = await f.query(sql);
          if (sql.startsWith('COPY')) abort.abort(new Error('cancel migration'));
          return result;
        },
      }),
    ).rejects.toThrow('cancel migration');
    expect((await fs.readdir(f.root)).filter((name) => /generation|\.csv$/.test(name))).toEqual([]);
    expect((await f.query('MATCH (e:CodeEmbedding) RETURN count(e) AS count'))[0].count).toBe(1);
  } finally {
    await f.close();
  }
});
