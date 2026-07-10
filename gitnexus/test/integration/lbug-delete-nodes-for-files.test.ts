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
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { buildTestGraph, type TestNodeInput, type TestRelInput } from '../helpers/test-graph.js';
import { DELETE_FILES_CHUNK_SIZE } from '../../src/core/lbug/lbug-adapter.js';

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
    it('deletes exactly the requested files across chunks with DETACH semantics, quote escaping, and zero-match no-ops', async () => {
      const { loadGraphToLbug, deleteNodesForFiles, executeQuery } =
        await import('../../src/core/lbug/lbug-adapter.js');

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

      // Zero-match batch (all paths already gone) is a clean no-op.
      await expect(deleteNodesForFiles([QUOTED_PATH, filePath(1)])).resolves.toBeUndefined();
    }, 120_000);
  });
});
