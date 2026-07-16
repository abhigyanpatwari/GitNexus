/**
 * Integration coverage for `deleteNodesForFiles` — the batched incremental
 * delete introduced for #2409.
 *
 * The per-file predecessor issued a count + DETACH DELETE per node table per
 * FILE (~13k single-row write transactions on a ~700-file write set); the
 * batched variant chunks paths into `IN [...]` lists. These tests pin the
 * contract the incremental writeback depends on:
 *
 *   - exactly the requested files' rows are deleted, across a >1-chunk set
 *   - DETACH semantics: relationships touching deleted nodes go away,
 *     relationships between survivors stay
 *   - single quotes in paths are escaped, not injected
 *   - unknown paths are a no-op success (zero-match ≠ error)
 *   - onChunk progress reports cumulative file counts
 *   - CodeEmbedding rows ride along with their file's nodes (tri-review
 *     4669518496 P2-1): node ids are label-first (`Function:<fp>:fn:1`), so
 *     the delete joins `e.nodeId = n.id` through the still-present nodes —
 *     deleted/quoted files' rows go, survivors' rows stay.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { buildTestGraph, type TestNodeInput, type TestRelInput } from '../helpers/test-graph.js';
import { DELETE_FILES_CHUNK_SIZE } from '../../src/core/lbug/lbug-adapter.js';
import { EMBEDDING_TABLE_NAME, EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';

const FILE_COUNT = DELETE_FILES_CHUNK_SIZE + 30; // crosses the chunk boundary
const KEEP_COUNT = 10;
const QUOTED_PATH = "src/we'ird.ts";

const filePath = (i: number): string => `src/f-${String(i).padStart(4, '0')}.ts`;

function buildFixtureGraph() {
  const nodes: TestNodeInput[] = [];
  const rels: TestRelInput[] = [];
  for (let i = 0; i < FILE_COUNT; i++) {
    const fp = i === 0 ? QUOTED_PATH : filePath(i);
    nodes.push({ id: `File:${fp}`, label: 'File', name: path.basename(fp), filePath: fp });
    nodes.push({
      id: `Function:${fp}:fn${i}:1`,
      label: 'Function',
      name: `fn${i}`,
      filePath: fp,
      startLine: 1,
      endLine: 3,
      isExported: true,
    });
    rels.push({ sourceId: `File:${fp}`, targetId: `Function:${fp}:fn${i}:1`, type: 'CONTAINS' });
    if (i > 0) {
      // Every function calls the previous file's function — so deleting a
      // file must DETACH-drop edges on both sides of the kept/deleted
      // boundary while the survivor-to-survivor edges remain.
      const prev = i === 1 ? QUOTED_PATH : filePath(i - 1);
      rels.push({
        sourceId: `Function:${fp}:fn${i}:1`,
        targetId: `Function:${prev}:fn${i - 1}:1`,
        type: 'CALLS',
      });
    }
  }
  return buildTestGraph(nodes, rels);
}

withTestLbugDB('delete-nodes-for-files', (handle) => {
  describe('deleteNodesForFiles (batched incremental delete, #2409)', () => {
    it('deletes exactly the requested files across chunks with DETACH semantics, quote escaping, embedding-row joins, and zero-match no-ops', async () => {
      const { loadGraphToLbug, deleteNodesForFiles, executeQuery, executeWithReusedStatement } =
        await import('../../src/core/lbug/lbug-adapter.js');
      const { batchInsertEmbeddings } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      await loadGraphToLbug(buildFixtureGraph(), '/tmp/repo', path.dirname(handle.dbPath));

      const count = async (cypher: string): Promise<number> => {
        const rows = (await executeQuery(cypher)) as Array<{ c: number | bigint }>;
        return Number(rows[0]?.c ?? 0);
      };

      expect(await count('MATCH (n:File) RETURN count(n) AS c')).toBe(FILE_COUNT);
      expect(await count('MATCH (n:Function) RETURN count(n) AS c')).toBe(FILE_COUNT);
      const callsBefore = await count(
        `MATCH ()-[r:CodeRelation]->() WHERE r.type = 'CALLS' RETURN count(r) AS c`,
      );
      expect(callsBefore).toBe(FILE_COUNT - 1);

      // Seed embedding rows through the real batchInsertEmbeddings for a
      // to-be-deleted plain-path file, the quoted-path file, and a survivor.
      // nodeIds are the fixture's REAL label-first node ids — the exact
      // format the old bare-path `STARTS WITH` shape could never match
      // (tri-review 4669518496 P2-1). Zero vectors: the CodeEmbedding table
      // is plain schema (no VECTOR extension involved).
      const SURVIVOR_PATH = filePath(FILE_COUNT - 1);
      const survivorEmbeddingNodeId = `Function:${SURVIVOR_PATH}:fn${FILE_COUNT - 1}:1`;
      const survivorFileEmbeddingNodeId = `File:${SURVIVOR_PATH}`;
      const seededEmbeddingNodeIds = [
        `Function:${filePath(1)}:fn1:1`, // deleted, plain path
        `File:${filePath(1)}`, // deleted fallback File embedding, plain path
        `Function:${QUOTED_PATH}:fn0:1`, // deleted, quoted path
        `File:${QUOTED_PATH}`, // deleted fallback File embedding, quoted path
        survivorEmbeddingNodeId, // survives the delete
        survivorFileEmbeddingNodeId, // fallback File embedding also survives
      ];
      await batchInsertEmbeddings(
        executeWithReusedStatement,
        seededEmbeddingNodeIds.map((nodeId) => ({
          nodeId,
          chunkIndex: 0,
          startLine: 1,
          endLine: 3,
          embedding: new Array(EMBEDDING_DIMS).fill(0),
        })),
      );
      expect(await count(`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS c`)).toBe(
        seededEmbeddingNodeIds.length,
      );

      // Delete everything except the last KEEP_COUNT files. Includes the
      // quoted path (chunk 1), crosses into chunk 2, and appends a path with
      // no rows at all — which must not fail the batch.
      const toDelete: string[] = [QUOTED_PATH];
      for (let i = 1; i < FILE_COUNT - KEEP_COUNT; i++) toDelete.push(filePath(i));
      toDelete.push('src/never-existed.ts');

      const chunkCalls: Array<[number, number]> = [];
      await deleteNodesForFiles(toDelete, {
        onChunk: (done, total) => chunkCalls.push([done, total]),
      });

      // Cumulative chunk progress: [200, 221] then [221, 221].
      expect(chunkCalls).toEqual([
        [DELETE_FILES_CHUNK_SIZE, toDelete.length],
        [toDelete.length, toDelete.length],
      ]);

      expect(await count('MATCH (n:File) RETURN count(n) AS c')).toBe(KEEP_COUNT);
      expect(await count('MATCH (n:Function) RETURN count(n) AS c')).toBe(KEEP_COUNT);
      // Quoted path really gone (escaping worked; nothing else was swept up).
      expect(
        await count(`MATCH (n:File) WHERE n.filePath = "${QUOTED_PATH}" RETURN count(n) AS c`),
      ).toBe(0);
      // DETACH: the only CALLS edges left are between surviving functions —
      // KEEP_COUNT survivors form a chain of KEEP_COUNT-1 edges; the edge from
      // the first survivor into the deleted region is gone.
      expect(
        await count(`MATCH ()-[r:CodeRelation]->() WHERE r.type = 'CALLS' RETURN count(r) AS c`),
      ).toBe(KEEP_COUNT - 1);
      // Survivors untouched.
      expect(
        await count(
          `MATCH (n:File) WHERE n.filePath = '${filePath(FILE_COUNT - 1)}' RETURN count(n) AS c`,
        ),
      ).toBe(1);
      // Embedding rows followed their files: ONLY the survivor's row remains
      // — exact nodeId, not count-only, so a delete that swept the wrong rows
      // (or none) cannot pass. The quoted-path row proves the join statement
      // escapes list literals, not just the per-table deletes.
      const embRows = (await executeQuery(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId`,
      )) as Array<{ nodeId: string }>;
      expect(embRows.map((r) => String(r.nodeId)).sort()).toEqual(
        [survivorEmbeddingNodeId, survivorFileEmbeddingNodeId].sort(),
      );

      // Zero-match batch (all paths already gone) is a clean no-op.
      await expect(deleteNodesForFiles([QUOTED_PATH, filePath(1)])).resolves.toBeUndefined();
      // …and it left the surviving embedding row alone.
      expect(await count(`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS c`)).toBe(2);
    }, 120_000);

    it('a File node without an embedding deletes cleanly and leaves other files’ embedding rows intact (FIX 4)', async () => {
      const { deleteNodesForFiles, executeQuery } =
        await import('../../src/core/lbug/lbug-adapter.js');
      const count = async (cypher: string): Promise<number> => {
        const rows = (await executeQuery(cypher)) as Array<{ c: number | bigint }>;
        return Number(rows[0]?.c ?? 0);
      };

      // File can own fallback embeddings, but this fixture deliberately has
      // none. The delete must still remove the node row without erroring, and
      // embedding rows owned by OTHER files stay put.
      const ASSET_PATH = 'src/assets-only.txt';
      await executeQuery(
        `CREATE (:File {id: 'File:${ASSET_PATH}', name: 'assets-only.txt', filePath: '${ASSET_PATH}'})`,
      );
      const embeddingsBefore = await count(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS c`,
      );

      await expect(deleteNodesForFiles([ASSET_PATH])).resolves.toBeUndefined();

      expect(
        await count(`MATCH (n:File) WHERE n.filePath = '${ASSET_PATH}' RETURN count(n) AS c`),
      ).toBe(0);
      expect(await count(`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS c`)).toBe(
        embeddingsBefore,
      );
    }, 120_000);

    it('deleteNodesForFile removes a fallback embedding owned by the File node', async () => {
      const { deleteNodesForFile, executeQuery, executeWithReusedStatement } =
        await import('../../src/core/lbug/lbug-adapter.js');
      const { batchInsertEmbeddings } =
        await import('../../src/core/embeddings/embedding-pipeline.js');
      const count = async (cypher: string): Promise<number> => {
        const rows = (await executeQuery(cypher)) as Array<{ c: number | bigint }>;
        return Number(rows[0]?.c ?? 0);
      };

      const filePath = 'docs/singular.md';
      const nodeId = `File:${filePath}`;
      await executeQuery(
        `CREATE (:File {id: '${nodeId}', name: 'singular.md', filePath: '${filePath}'})`,
      );
      await batchInsertEmbeddings(executeWithReusedStatement, [
        {
          nodeId,
          chunkIndex: 0,
          startLine: 1,
          endLine: 1,
          embedding: new Array(EMBEDDING_DIMS).fill(0),
        },
      ]);

      await expect(deleteNodesForFile(filePath)).resolves.toEqual({ deletedNodes: 1 });
      expect(
        await count(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) WHERE e.nodeId = '${nodeId}' RETURN count(e) AS c`,
        ),
      ).toBe(0);
    }, 120_000);
  });
});

/**
 * Missing-embedding-table tolerance (FIX 4): a DB created without
 * EMBEDDING_SCHEMA raises `Binder exception: Table CodeEmbedding does not
 * exist.` (probe-recorded on @ladybugdb/core 0.18.0) on the join-delete.
 * deleteNodesForFiles must tolerate exactly that one case — warn and keep
 * going — instead of bricking every incremental run until `--force`, while
 * the node-table deletes still complete. Own withTestLbugDB block: the
 * DROP TABLE would poison the sibling suite's shared DB.
 */
withTestLbugDB('delete-nodes-missing-embedding-table', () => {
  describe('deleteNodesForFiles without a CodeEmbedding table (FIX 4)', () => {
    it('resolves, still deletes the node rows, and later statements keep working', async () => {
      const { deleteNodesForFiles, executeQuery } =
        await import('../../src/core/lbug/lbug-adapter.js');
      const count = async (cypher: string): Promise<number> => {
        const rows = (await executeQuery(cypher)) as Array<{ c: number | bigint }>;
        return Number(rows[0]?.c ?? 0);
      };

      await executeQuery(
        `CREATE (:Function {id: 'Function:src/a.ts:fnA:1', name: 'fnA', filePath: 'src/a.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
      );
      await executeQuery(
        `CREATE (:Function {id: 'Function:src/b.ts:fnB:1', name: 'fnB', filePath: 'src/b.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
      );
      // Build-variant DB without the embedding schema.
      await executeQuery(`DROP TABLE ${EMBEDDING_TABLE_NAME}`);

      await expect(deleteNodesForFiles(['src/a.ts'])).resolves.toBeUndefined();

      // The node delete completed despite the tolerated missing-table warn…
      expect(
        await count(`MATCH (n:Function) WHERE n.filePath = 'src/a.ts' RETURN count(n) AS c`),
      ).toBe(0);
      // …the untouched file survives…
      expect(
        await count(`MATCH (n:Function) WHERE n.filePath = 'src/b.ts' RETURN count(n) AS c`),
      ).toBe(1);
      // …and the connection stays healthy for subsequent batches.
      await expect(deleteNodesForFiles(['src/b.ts'])).resolves.toBeUndefined();
      expect(await count(`MATCH (n:Function) RETURN count(n) AS c`)).toBe(0);
    }, 120_000);
  });
});
