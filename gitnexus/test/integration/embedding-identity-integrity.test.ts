import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { batchInsertEmbeddings } from '../../src/core/embeddings/embedding-pipeline.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';

describe('embedding identity integrity (#3569)', () => {
  let tmp: TestDBHandle | undefined;
  afterEach(async () => {
    await adapter.closeLbug();
    await tmp?.cleanup();
    tmp = undefined;
  });

  it.each([
    '',
    '   ',
    '\0broken',
    'bad\x01id',
    `bad${String.fromCharCode(0xd800)}id`,
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
    '',
    '   ',
    'Function:bad\0id',
    'Function:bad\x01id',
    `Function:bad${String.fromCharCode(0xd800)}id`,
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
});
