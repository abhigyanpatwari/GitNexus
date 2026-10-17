import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { createTempDir } from '../helpers/test-db.js';

afterEach(() => vi.unstubAllEnvs());

async function fixture(reject: (text: string) => boolean) {
  const tmp = await createTempDir('gn-embedding-input-');
  const repo = path.join(tmp.dbPath, 'repo');
  await fs.mkdir(repo);
  const requests: string[][] = [];
  const server = createServer(async (request, response) => {
    const pieces: Buffer[] = [];
    for await (const piece of request) pieces.push(Buffer.from(piece));
    const { input } = JSON.parse(Buffer.concat(pieces).toString()) as { input: string[] };
    requests.push(input);
    response.setHeader('content-type', 'application/json');
    if (input.some(reject)) {
      response.writeHead(400).end(JSON.stringify({ error: 'fixture input rejected' }));
      return;
    }
    response.end(
      JSON.stringify({
        data: input.map((_, index) => ({
          index,
          embedding: Array<number>(EMBEDDING_DIMS).fill(0.125),
        })),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected endpoint');
  vi.stubEnv('GITNEXUS_HOME', path.join(tmp.dbPath, 'home'));
  vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
  vi.stubEnv('GITNEXUS_EMBEDDING_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'input-isolation-fixture');
  vi.stubEnv('GITNEXUS_EMBEDDING_MAX_ATTEMPTS', '1');
  vi.stubEnv('GITNEXUS_EMBEDDING_MAX_INPUT_CHARS', '4096');
  vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'auto');
  const analyze = (embeddings: boolean) =>
    runFullAnalysis(
      repo,
      {
        skipGit: true,
        embeddings,
        embeddingsNodeLimit: 0,
        skipSkills: true,
        skipAgentsMd: true,
      },
      { onProgress: () => {} },
    );
  const rows = async () => {
    await adapter.initLbug(getStoragePaths(repo).lbugPath);
    try {
      return await adapter.executeQuery(
        'MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex',
      );
    } finally {
      await adapter.closeLbug();
    }
  };
  const cleanup = async () => {
    await adapter.closeLbug();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await tmp.cleanup();
  };
  return { repo, requests, analyze, rows, cleanup };
}

it('budgets complete generated single-line structural inputs after real CJK indexing (#3607)', async () => {
  const f = await fixture((text) => text.length > 4096);
  try {
    vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
    await fs.writeFile(
      path.join(f.repo, 'payload.ts'),
      `export interface Payload { /* ${'中文文档'.repeat(1800)} */ value: string; }\n` +
        Array.from({ length: 4 }, (_, i) => `export function healthy${i}() { return ${i}; }`).join(
          '\n',
        ),
    );
    const result = await f.analyze(true).catch((error: unknown) => error);
    const submitted = f.requests.flat();
    expect(submitted.length).toBeGreaterThan(0);
    expect(Math.max(...submitted.map((text) => text.length))).toBeLessThanOrEqual(4096);
    expect(result).not.toBeInstanceOf(Error);
    const rows = await f.rows();
    for (let i = 0; i < 4; i++)
      expect(rows.some((row) => row.nodeId === `Function:payload.ts:healthy${i}`)).toBe(true);
    expect(rows.some((row) => row.nodeId === 'Interface:payload.ts:Payload')).toBe(true);
    expect(
      (await loadMeta(getStoragePaths(f.repo).storagePath))?.embeddingCheckpoint,
    ).toBeUndefined();
  } finally {
    await f.cleanup();
  }
}, 120_000);

it('isolates a permanently rejected input, retains healthy peers and retries only unresolved work (#3607)', async () => {
  let rejectInput = true;
  const f = await fixture((text) => rejectInput && text.includes('REJECT_ALWAYS'));
  try {
    await fs.writeFile(
      path.join(f.repo, 'handlers.ts'),
      `export function rejected() { return 'REJECT_ALWAYS'; }\n` +
        Array.from({ length: 5 }, (_, i) => `export function healthy${i}() { return ${i}; }`).join(
          '\n',
        ),
    );
    await f.analyze(true).catch((error: unknown) => error);
    const rows = await f.rows();
    expect(new Set(rows.map((row) => row.nodeId))).toEqual(
      new Set(Array.from({ length: 5 }, (_, i) => `Function:handlers.ts:healthy${i}`)),
    );
    const meta = await loadMeta(getStoragePaths(f.repo).storagePath);
    expect(meta?.embeddingCheckpoint?.pendingNodeIds).toEqual(['Function:handlers.ts:rejected']);
    expect(f.requests.length).toBeLessThanOrEqual(11); // Binary isolation: at most 2n-1 calls.
    f.requests.length = 0;
    await f.analyze(false).catch((error: unknown) => error);
    expect(f.requests.flat()).toHaveLength(1);
    expect(f.requests.flat().every((text) => text.includes('REJECT_ALWAYS'))).toBe(true);
    expect(await f.rows()).toEqual(rows);
    rejectInput = false;
    f.requests.length = 0;
    await f.analyze(false);
    expect(f.requests.flat()).toHaveLength(1);
    expect(new Set((await f.rows()).map((row) => row.nodeId)).size).toBe(6);
    expect(
      (await loadMeta(getStoragePaths(f.repo).storagePath))?.embeddingCheckpoint,
    ).toBeUndefined();
  } finally {
    await f.cleanup();
  }
}, 120_000);

it('bounds an all-400 endpoint, persists incomplete work and recovers after endpoint repair', async () => {
  let rejectAll = true;
  const f = await fixture(() => rejectAll);
  try {
    await fs.writeFile(
      path.join(f.repo, 'handlers.ts'),
      Array.from({ length: 40 }, (_, i) => `export function handler${i}() { return ${i}; }`).join(
        '\n',
      ),
    );
    const failed = await f.analyze(true).catch((error: unknown) => error);
    expect(f.requests.length).toBeLessThanOrEqual(30); // First 16 nodes, two binary trees.
    expect(await f.rows()).toHaveLength(0);
    const meta = await loadMeta(getStoragePaths(f.repo).storagePath);
    expect(meta?.embeddingCheckpoint).toBeDefined();
    // The indexer's embedding boundary may return graph success with an explicit
    // incomplete receipt; it must never turn the failed phase into completion.
    expect(failed instanceof Error || meta?.embeddingCheckpoint !== undefined).toBe(true);
    rejectAll = false;
    f.requests.length = 0;
    await f.analyze(false);
    expect(new Set((await f.rows()).map((row) => row.nodeId)).size).toBe(40);
    expect(
      (await loadMeta(getStoragePaths(f.repo).storagePath))?.embeddingCheckpoint,
    ).toBeUndefined();
  } finally {
    await f.cleanup();
  }
}, 120_000);
