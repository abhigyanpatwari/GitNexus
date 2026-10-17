import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import {
  batchInsertEmbeddings,
  runEmbeddingPipeline,
} from '../../src/core/embeddings/embedding-pipeline.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { seedEmbeddingsForFiles, stampEmbeddingCount } from '../helpers/embedding-seed.js';

describe('embedding identity integrity (#3569)', () => {
  let tmp: TestDBHandle | undefined;
  afterEach(async () => {
    await adapter.closeLbug();
    await tmp?.cleanup();
    tmp = undefined;
    vi.unstubAllEnvs();
  });

  it.each([
    '',
    '   ',
    '\0broken',
    'bad\x01id',
    'bad\uD800id',
    'duplicate',
    'negative-chunk',
    'fractional-chunk',
    'overflow-chunk',
  ])('rejects %j before replacing any existing embedding', async (invalid) => {
    tmp = await createTempDir('gitnexus-test-embedding-identity-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    await adapter.initLbug(dbPath, { skipFts: true });
    const original = {
      nodeId: 'Function:source.ts:healthy',
      chunkIndex: 0,
      startLine: 1,
      endLine: 3,
      embedding: Array<number>(EMBEDDING_DIMS).fill(0),
      contentHash: 'previous-valid',
    };
    await batchInsertEmbeddings(adapter.executeWithReusedStatement, [original]);
    const replacement = { ...original, contentHash: 'replacement' };
    const invalidUpdate =
      invalid === 'duplicate'
        ? { ...replacement }
        : {
            ...replacement,
            nodeId: invalid.endsWith('-chunk') ? 'Function:source.ts:other' : invalid,
            chunkIndex:
              invalid === 'negative-chunk'
                ? -1
                : invalid === 'fractional-chunk'
                  ? 0.5
                  : invalid === 'overflow-chunk'
                    ? 2147483648
                    : 0,
          };
    const failure = await batchInsertEmbeddings(adapter.executeWithReusedStatement, [
      invalidUpdate,
      replacement,
    ]).catch((error: unknown) => error);
    await adapter.closeLbug();
    await adapter.initLbug(dbPath, { skipFts: true });
    const rows = await adapter.executeQuery(
      'MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.contentHash AS contentHash',
    );
    expect(rows).toEqual([{ nodeId: original.nodeId, contentHash: original.contentHash }]);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/embedding.*(identity|node.?id|key|chunk)/i);
  });

  it.each([
    { limit: '2048', invalid: 'negative' },
    { limit: '0', invalid: 'negative' },
    { limit: '0', invalid: 'blank' },
    { limit: '2048', invalid: 'duplicate' },
  ])(
    'preserves healthy cached vectors before writeback ($invalid, limit=$limit)',
    async ({ limit, invalid }) => {
      tmp = await createTempDir('gitnexus-test-corrupt-cache-');
      const repo = path.join(tmp.dbPath, 'repo');
      await fs.mkdir(repo);
      vi.stubEnv('GITNEXUS_HOME', path.join(tmp.dbPath, 'home'));
      vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
      vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
      vi.stubEnv('GITNEXUS_EMBEDDING_CACHE_IN_MEMORY_LIMIT', limit);
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const source = path.join(repo, 'source.ts');
      await fs.writeFile(
        source,
        'export function good() { return 1; }\nexport function bad() { return 2; }\n',
      );
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-qm',
          'initial',
        ],
        { cwd: repo },
      );
      await runFullAnalysis(repo, { skipFts: true }, { onProgress: () => {} });
      const { lbugPath, storagePath } = getStoragePaths(repo);
      const seeded = await seedEmbeddingsForFiles(repo, ['source.ts'], 2);
      expect(seeded.get('source.ts')).toHaveLength(2);
      await stampEmbeddingCount(storagePath, 2);
      const oldMeta = await loadMeta(storagePath);
      await adapter.initLbug(lbugPath, { skipFts: true });
      const badId = seeded.get('source.ts')![1]!;
      const goodId = seeded.get('source.ts')![0]!;
      // Controlled stored corruption, not a reproduction of the host's producer.
      await adapter.executeWithReusedStatement(
        invalid === 'negative'
          ? 'MATCH (e:CodeEmbedding {nodeId: $id}) SET e.chunkIndex = -1'
          : 'MATCH (e:CodeEmbedding {nodeId: $id}) SET e.nodeId = $replacement',
        [{ id: badId, replacement: invalid === 'blank' ? '' : goodId }],
      );
      const query =
        'MATCH (e:CodeEmbedding) RETURN e.id AS id, e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.embedding AS embedding ORDER BY id';
      const before = await adapter.executeQuery(query);
      await adapter.closeLbug();
      await fs.appendFile(source, '// incremental update\n');
      const failure = await runFullAnalysis(
        repo,
        { skipFts: true },
        { onProgress: () => {} },
      ).catch((error: unknown) => error);
      await adapter.closeLbug();
      await adapter.initLbug(lbugPath, { skipFts: true });
      expect(await adapter.executeQuery(query)).toEqual(before);
      expect(await loadMeta(storagePath)).toEqual(oldMeta);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/embedding.*(identity|node.?id|key|chunk)/i);
    },
    180_000,
  );

  it.each([
    '',
    '   ',
    'Function:bad\0id',
    'Function:bad\x01id',
    'Function:bad\uD800id',
    'Function:bad\rid',
    'Function:bad\uFFFFid',
  ])('rejects malformed graph ID %j before CSV COPY', async (id) => {
    tmp = await createTempDir('gitnexus-test-graph-identity-');
    await adapter.initLbug(path.join(tmp.dbPath, 'lbug'), { skipFts: true });
    const graph = createKnowledgeGraph();
    graph.addNode({
      id,
      label: 'Function',
      properties: { name: 'bad', filePath: 'source.ts', startLine: 1, endLine: 1 },
    });
    await expect(
      adapter.loadGraphToLbug(
        graph,
        tmp.dbPath,
        tmp.dbPath,
        undefined,
        undefined,
        undefined,
        'none',
      ),
    ).rejects.toThrow(/invalid.*node.*id/i);
    expect(await adapter.executeQuery('MATCH (n:Function) RETURN n.id AS id')).toEqual([]);
  });

  it('preserves distinct supplementary Unicode identities through COPY and cold reopen', async () => {
    tmp = await createTempDir('gitnexus-test-unicode-identity-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    await adapter.initLbug(dbPath, { skipFts: true });
    const graph = createKnowledgeGraph();
    const ids = ['Function:source.ts:ab', 'Function:source.ts:a😀b'];
    for (const id of ids) {
      graph.addNode({
        id,
        label: 'Function',
        properties: {
          name: id,
          filePath: 'source.ts',
          startLine: 1,
          endLine: 1,
        },
      });
    }
    await adapter.loadGraphToLbug(
      graph,
      tmp.dbPath,
      tmp.dbPath,
      undefined,
      undefined,
      undefined,
      'none',
    );
    expect(await adapter.tryFlushWAL()).toBe(true);
    await adapter.closeLbug();
    await adapter.initLbug(dbPath, { skipFts: true });
    const rows = await adapter.executeQuery('MATCH (n:Function) RETURN n.id AS id');
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set(ids));
  });

  it.each(['blank', 'duplicate'])(
    'rejects a persisted %s identity before endpoint calls or replacing valid vectors',
    async (invalid) => {
      const inputs: string[] = [];
      const server = createServer(async (request, response) => {
        const pieces: Buffer[] = [];
        for await (const piece of request) pieces.push(Buffer.from(piece));
        const body = JSON.parse(Buffer.concat(pieces).toString()) as { input: string[] };
        inputs.push(...body.input);
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            data: body.input.map((_, index) => ({
              index,
              embedding: Array<number>(EMBEDDING_DIMS).fill(0),
            })),
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected loopback server');
        vi.stubEnv('GITNEXUS_EMBEDDING_URL', `http://127.0.0.1:${address.port}`);
        vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'identity-fixture');
        vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
        tmp = await createTempDir('gitnexus-test-persisted-identity-');
        await adapter.initLbug(path.join(tmp.dbPath, 'lbug'), { skipFts: true });
        // Controlled malformed stored row; this does not claim to reproduce the
        // original Windows Java producer that left thousands of blank scan rows.
        await adapter.executeQuery(
          invalid === 'blank'
            ? "CREATE (:Function {id: '', name: 'broken', filePath: 'bad.ts', content: 'export function broken() {}', startLine: 1, endLine: 1})"
            : "CREATE (:Method {id: 'Function:good.ts:good', name: 'broken', filePath: 'bad.ts', content: 'broken() {}', startLine: 1, endLine: 1})",
        );
        await adapter.executeQuery(
          "CREATE (:Function {id: 'Function:good.ts:good', name: 'good', filePath: 'good.ts', content: 'export function good() { return 1; }', startLine: 1, endLine: 1})",
        );
        const good = {
          nodeId: 'Function:good.ts:good',
          chunkIndex: 0,
          startLine: 1,
          endLine: 1,
          embedding: Array<number>(EMBEDDING_DIMS).fill(0),
          contentHash: 'old-valid',
        };
        await batchInsertEmbeddings(adapter.executeWithReusedStatement, [good]);
        const failure = await runEmbeddingPipeline(
          adapter.executeQuery,
          adapter.executeWithReusedStatement,
          () => {},
          {},
          undefined,
          new Map([[good.nodeId, good.contentHash]]),
        ).catch((error: unknown) => error);
        expect(inputs).toEqual([]);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/invalid.*node.*id|duplicate.*node.*id/i);
        expect(
          await adapter.executeQuery('MATCH (e:CodeEmbedding) RETURN e.contentHash AS contentHash'),
        ).toEqual([{ contentHash: 'old-valid' }]);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
