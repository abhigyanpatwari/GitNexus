import path from 'node:path';
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

describe('embedding identity integrity (#3569)', () => {
  let tmp: TestDBHandle | undefined;
  afterEach(async () => {
    await adapter.closeLbug();
    await tmp?.cleanup();
    tmp = undefined;
    vi.unstubAllEnvs();
  });

  it.each(['', '   ', '\0broken', 'duplicate', 'negative-chunk', 'fractional-chunk'])(
    'rejects %j before replacing any existing embedding',
    async (invalid) => {
      tmp = await createTempDir('gn-embedding-identity-');
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
                invalid === 'negative-chunk' ? -1 : invalid === 'fractional-chunk' ? 0.5 : 0,
            };
      const failure = await batchInsertEmbeddings(adapter.executeWithReusedStatement, [
        replacement,
        invalidUpdate,
      ]).catch((error: unknown) => error);
      await adapter.closeLbug();
      await adapter.initLbug(dbPath, { skipFts: true });
      const rows = await adapter.executeQuery(
        'MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.contentHash AS contentHash',
      );
      expect(rows).toEqual([{ nodeId: original.nodeId, contentHash: original.contentHash }]);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/embedding.*(identity|node.?id|key|chunk)/i);
    },
  );

  it.each(['', '   ', 'Function:bad\0id'])(
    'rejects malformed graph ID %j before CSV COPY',
    async (id) => {
      tmp = await createTempDir('gn-graph-identity-');
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
    },
  );

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
        tmp = await createTempDir('gn-persisted-identity-');
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
