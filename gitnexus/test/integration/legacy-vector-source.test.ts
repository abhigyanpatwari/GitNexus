import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VectorStore, type StoredVectorChunk } from '../../src/core/lbug/vector-store.js';
import {
  LegacyVectorSource,
  legacyVectorCompatibility,
  type LegacyVectorSourceOptions,
} from '../../src/core/lbug/legacy-vector-source.js';
import { openLbugConnection, closeLbugConnection } from '../../src/core/lbug/lbug-config.js';
import { chunkNode } from '../../src/core/embeddings/chunker.js';
import { contentHashForNode } from '../../src/core/embeddings/embedding-pipeline.js';
import {
  generateEmbeddingText,
  splitEmbeddingText,
} from '../../src/core/embeddings/text-generator.js';
import { resolveEmbeddingConfig } from '../../src/core/embeddings/config.js';
import { isShortLabel, type EmbeddableNode } from '../../src/core/embeddings/types.js';
import { createEmbeddingWorkManifest } from '../../src/core/embeddings/embedding-work-manifest.js';
import { EmbeddingJobJournal } from '../../src/storage/embedding-job-journal.js';
import { resolveAnalysisResourceBudget } from '../../src/core/analysis-resource-budget.js';
import { runEmbeddingJob } from '../../src/core/embeddings/embedding-job-runner.js';

const roots: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
const identity = { provider: 'local', model: 'recorded', dimensions: 4 };
const config = resolveEmbeddingConfig({ chunkSize: 200, overlap: 20, maxInputChars: 900 });
const node = (kind: 'File' | 'Const', content = 'const n = 1;'): EmbeddableNode => ({
  id: kind === 'File' ? 'File:a.txt' : 'Const:a.txt:n',
  name: 'n',
  label: kind,
  filePath: 'a.txt',
  content,
  startLine: 1,
  endLine: content.split('\n').length,
});
async function legacyChunks(input: EmbeddableNode): Promise<StoredVectorChunk[]> {
  const chunks = isShortLabel(input.label)
    ? [
        {
          text: input.content,
          chunkIndex: 0,
          startLine: input.startLine ?? 0,
          endLine: input.endLine ?? 0,
        },
      ]
    : await chunkNode(
        input.label,
        input.content,
        input.filePath,
        input.startLine ?? 0,
        input.endLine ?? 0,
        config.chunkSize,
        config.overlap,
      );
  const rows: StoredVectorChunk[] = [];
  let tail = '';
  for (const chunk of chunks) {
    const text = generateEmbeddingText(input, chunk.text, config, chunk.chunkIndex, tail);
    for (const _part of splitEmbeddingText(text, config.maxInputChars))
      rows.push({
        chunkIndex: rows.length,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        embedding: [1, 0, 0, 0],
      });
    tail = config.overlap > 0 ? chunk.text.slice(-config.overlap) : '';
  }
  return rows;
}
async function fixture(
  input: EmbeddableNode,
  adjust?: (rows: StoredVectorChunk[]) => StoredVectorChunk[],
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-legacy-source-'));
  roots.push(root);
  const dbPath = path.join(root, 'lbug');
  const handle = await openLbugConnection(lbug, dbPath, {
    bufferPoolBytes: 8 * 1024 * 1024,
    threads: 1,
  });
  const close = (result: lbug.QueryResult | lbug.QueryResult[]) => {
    for (const part of Array.isArray(result) ? result : [result]) part.close();
  };
  const hash = contentHashForNode(input, config);
  const chunks = await legacyChunks(input);
  try {
    close(
      await handle.conn.query(
        'CREATE NODE TABLE CodeEmbedding (id STRING, nodeId STRING, chunkIndex INT32, startLine INT64, endLine INT64, embedding FLOAT[4], contentHash STRING, PRIMARY KEY(id))',
      ),
    );
    const insert = await handle.conn.prepare(
      'CREATE (:CodeEmbedding {id:$id,nodeId:$nodeId,chunkIndex:$chunkIndex,startLine:$startLine,endLine:$endLine,embedding:$embedding,contentHash:$contentHash})',
    );
    for (const chunk of adjust ? adjust(chunks) : chunks)
      close(
        await handle.conn.execute(insert, {
          id: `${input.id}:${chunk.chunkIndex}`,
          nodeId: input.id,
          contentHash: hash,
          ...chunk,
        }),
      );
    close(await handle.conn.query('CHECKPOINT'));
  } finally {
    await closeLbugConnection(handle, { strict: true, databasePath: dbPath });
  }
  const directory = path.join(root, 'pending');
  await fs.mkdir(directory);
  const store = await VectorStore.open({
    directory,
    identity: 'b'.repeat(64),
    dimensions: 4,
    bufferPoolBytes: 32 * 1024 * 1024,
    threads: 1,
    batchBytes: 1024 * 1024,
    mode: 'create',
  });
  handles.push(store);
  const options: LegacyVectorSourceOptions = {
    path: dbPath,
    sourceIdentity: 'a'.repeat(64),
    recordedIdentity: identity,
    expectedIdentity: identity,
    recordedInputIdentity: 'c'.repeat(64),
    expectedInputIdentity: 'c'.repeat(64),
    config,
    bufferPoolBytes: 8 * 1024 * 1024,
    threads: 1,
    batchBytes: 1024 * 1024,
  };
  const open = async (
    override: Partial<LegacyVectorSourceOptions> = {},
    excluded: string[] = [],
  ) => {
    const source = await LegacyVectorSource.open(
      { ...options, ...override },
      store,
      () => excluded,
    );
    handles.push(source);
    return source;
  };
  return { root, directory, store, options, open, hash, chunks };
}
afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) await handle.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('verified legacy vector reuse', () => {
  it('builds a legacy reuse catalog above 50000 rows with admitted reader and writer pools', async () => {
    const f = await fixture(node('Const'));
    const budget = resolveAnalysisResourceBudget({
      effectiveMemoryBytes: 8 * 1024 ** 3,
      availableCpus: 4,
      modelMemoryMb: 0,
    });
    const pool = Math.floor(budget.embedding.vectorPoolBytes / 2);
    const db = await openLbugConnection(lbug, f.options.path, {
      bufferPoolBytes: pool,
      threads: 1,
    });
    try {
      const result = await db.conn.query(`UNWIND range(1, 50000) AS i CREATE (:CodeEmbedding {
        id:'Const:large.ts:n' + CAST(i AS STRING) + ':0', nodeId:'Const:large.ts:n' + CAST(i AS STRING),
        chunkIndex:0,startLine:1,endLine:1,embedding:[1,0,0,0],contentHash:'hash'})`);
      for (const cursor of Array.isArray(result) ? result : [result]) cursor.close();
    } finally {
      await closeLbugConnection(db, { strict: true, databasePath: f.options.path });
    }
    await f.store.close();
    const index = await VectorStore.open({
      ...f.store.options,
      bufferPoolBytes: pool,
      mode: 'resume',
    });
    handles.push(index);
    const source = await LegacyVectorSource.open(
      { ...f.options, bufferPoolBytes: pool },
      index,
      () => [],
    );
    handles.push(source);
    for (const [nodeId, contentHash] of [
      [node('Const').id, f.hash],
      ['Const:large.ts:n1', 'hash'],
      ['Const:large.ts:n50000', 'hash'],
    ])
      expect(await index.legacyReuseGroup(f.options.sourceIdentity, nodeId)).toMatchObject({
        nodeId,
        contentHash,
        chunks: 1,
      });
    expect(
      await index.legacyReuseGroup(f.options.sourceIdentity, 'Const:large.ts:n50001'),
    ).toBeNull();
  }, 120_000);

  it('relocates chunk spans without treating the last chunk as the whole node range', async () => {
    const original = {
      ...node('File', Array.from({ length: 80 }, (_, i) => `const v${i} = ${i};`).join('\n')),
      endLine: 200,
    };
    const f = await fixture(original);
    expect(Math.max(...f.chunks.map((chunk) => chunk.endLine))).toBeLessThan(original.endLine);
    const reuse = await f.open();
    const moved = { ...original, startLine: 11, endLine: 210 };
    expect(await reuse.reusable(moved.id, f.hash, { node: moved })).toMatchObject({
      complete: true,
      sourceStartLine: 1,
      sourceEndLine: undefined,
    });
  });
  it('rejects missing or different provider provenance before touching the database', async () => {
    expect(legacyVectorCompatibility(undefined, identity)).toContain('unknown');
    expect(
      legacyVectorCompatibility({ ...identity, provider: 'http:' + 'a'.repeat(64) }, identity),
    ).toContain('differ');
    expect(legacyVectorCompatibility(identity, identity)).toBeUndefined();
    const f = await fixture(node('Const'));
    await expect(f.open({ path: '/missing', recordedIdentity: undefined })).rejects.toThrow(
      'provenance is unknown',
    );
    await expect(
      f.open({ path: '/missing', recordedInputIdentity: 'd'.repeat(64) }),
    ).rejects.toThrow('input provenance differs');
  });
  it('validates a whole multi-chunk group, copies bounded batches, and relocates with zero provider calls', async () => {
    const original = node(
      'File',
      Array.from({ length: 80 }, (_, i) => `export const value${i} = ${i};`).join('\n'),
    );
    const f = await fixture(original);
    expect(f.chunks.length).toBeGreaterThan(1);
    const reuse = await f.open();
    const moved = { ...original, startLine: 11, endLine: (original.endLine ?? 0) + 10 };
    const source = {
      scan: async function* (label: string) {
        if (label === 'File')
          yield {
            id: moved.id,
            contentBytes: Buffer.byteLength(moved.content),
            metadataBytes: 512,
          };
      },
      fetch: async () => [moved],
    };
    const manifest = await createEmbeddingWorkManifest(f.directory, 'e'.repeat(64), source);
    const journal = await EmbeddingJobJournal.create(f.directory, 'b'.repeat(64), manifest);
    const provider = vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 0, 0, 0])),
    );
    const result = await runEmbeddingJob({
      directory: f.directory,
      manifest,
      journal,
      source,
      store: f.store,
      reuse,
      provider,
      config,
      queueBytes: 8 * 1024 * 1024,
    });
    expect(provider).not.toHaveBeenCalled();
    expect(result.state.reusedNodes).toBe(1);
    const receipt = await f.store.reusable(moved.id, f.hash);
    if (!receipt) throw new Error('Missing migrated receipt');
    expect(receipt.chunks).toBe(f.chunks.length);
    expect(await f.store.readChunks(receipt, 0, Math.min(8, receipt.chunks))).toEqual(
      f.chunks.slice(0, 8).map((chunk) => ({
        ...chunk,
        startLine: chunk.startLine + 10,
        endLine: chunk.endLine + 10,
      })),
    );
  });
  it('does not infer unknown multi-chunk settings from identical line spans', async () => {
    const input = node('File', 'a'.repeat(800));
    const f = await fixture(input);
    expect(f.chunks.length).toBeGreaterThan(1);
    expect(new Set(f.chunks.map((c) => `${c.startLine}:${c.endLine}`)).size).toBe(1);
    const log = vi.fn();
    const reuse = await f.open({ recordedInputIdentity: undefined, log });
    expect(await reuse.reusable(input.id, f.hash, { node: input })).toBeNull();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('chunk size/overlap');
  });
  it('can prove an unchunked short-label input without inventing a historical input receipt', async () => {
    const input = node('Const');
    const f = await fixture(input);
    const reuse = await f.open({ recordedInputIdentity: undefined });
    expect(await reuse.reusable(input.id, f.hash, { node: input })).toMatchObject({
      chunks: f.chunks.length,
    });
    expect(reuse.options.recordedInputIdentity).toBeUndefined();
  });
  it('rejects changed hashes, holes, and groups in an unsafe checkpoint window', async () => {
    const input = node('File', 'x'.repeat(1000));
    const f = await fixture(input, (rows) => rows.filter((row) => row.chunkIndex !== 1));
    expect(await (await f.open()).reusable(input.id, f.hash, { node: input })).toBeNull();
    const intact = await fixture(input);
    const excluded = await intact.open({}, [input.id]);
    expect(await excluded.reusable(input.id, intact.hash, { node: input })).toBeNull();
    const changed = await fixture(node('Const'));
    expect(
      await (await changed.open()).reusable('Const:a.txt:n', 'different', { node: node('Const') }),
    ).toBeNull();
  });
});
