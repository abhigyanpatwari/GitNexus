/**
 * Integration coverage for `queryImportersBatch` — the batched importer-BFS
 * read introduced for #2409 (one `IN [...]` IMPORTS query per 200-path chunk
 * per BFS depth, instead of one lock-taking round-trip per frontier file).
 *
 * Pins the contract the incremental writeback depends on:
 *
 *   - a >1-chunk target set is answered by ONE call (two queries) returning
 *     the full importer set, SORTED and DEDUPED across the chunk boundary
 *   - an importer of multiple targets inside the SAME chunk appears once
 *   - quoted-path targets match (list-literal escaping, not injection)
 *   - empty targets → `[]` (zero queries)
 *   - failure branch (tri-review 4669518496 P2-5): a failing chunk query is
 *     degrade-don't-fail — the result just shrinks — but no longer silent:
 *     `onChunkFailure` fires once per dropped chunk with the engine error.
 *     Empirically provoked with `DROP TABLE CodeRelation` (supported by
 *     @ladybugdb/core 0.18.0), which poisons that block's DB — hence the
 *     DEDICATED trailing `withTestLbugDB` block.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { buildTestGraph, type TestNodeInput, type TestRelInput } from '../helpers/test-graph.js';
import { DELETE_FILES_CHUNK_SIZE } from '../../src/core/lbug/lbug-adapter.js';

const TARGET_COUNT = DELETE_FILES_CHUNK_SIZE + 1; // 201 — crosses the chunk boundary (2 queries)
const QUOTED_TARGET = "src/targets/we'ird.ts";

// Importer names chosen so lexicographic order ≠ discovery order: the
// second chunk's exclusive importer (`aa-…`) must sort FIRST in the final
// result even though its chunk is queried LAST.
const SECOND_CHUNK_IMPORTER = 'src/importers/aa-second-chunk.ts';
const SAME_CHUNK_IMPORTER = 'src/importers/mm-same-chunk.ts';
const QUOTED_IMPORTER = 'src/importers/qq-quoted.ts';
const CROSS_CHUNK_IMPORTER = 'src/importers/zz-cross-chunk.ts';

const targetPath = (i: number): string => `src/targets/t-${String(i).padStart(4, '0')}.ts`;

/** Index 0 is the quoted path; the rest are plain. Length = TARGET_COUNT. */
function buildTargetList(): string[] {
  const targets: string[] = [QUOTED_TARGET];
  for (let i = 1; i < TARGET_COUNT; i++) targets.push(targetPath(i));
  return targets;
}

function buildFixtureGraph() {
  const nodes: TestNodeInput[] = [];
  const rels: TestRelInput[] = [];
  for (const fp of buildTargetList()) {
    nodes.push({ id: `File:${fp}`, label: 'File', name: path.basename(fp), filePath: fp });
  }
  for (const fp of [
    SECOND_CHUNK_IMPORTER,
    SAME_CHUNK_IMPORTER,
    QUOTED_IMPORTER,
    CROSS_CHUNK_IMPORTER,
  ]) {
    nodes.push({ id: `File:${fp}`, label: 'File', name: path.basename(fp), filePath: fp });
  }
  const imports = (importer: string, target: string): void => {
    rels.push({ sourceId: `File:${importer}`, targetId: `File:${target}`, type: 'IMPORTS' });
  };
  // Chunk 1 targets (list indices 0-199): the quoted path, t-0001…t-0199.
  // Chunk 2 target (index 200): t-0200.
  imports(SECOND_CHUNK_IMPORTER, targetPath(TARGET_COUNT - 1)); // chunk 2 only
  imports(SAME_CHUNK_IMPORTER, targetPath(2)); // both in chunk 1 —
  imports(SAME_CHUNK_IMPORTER, targetPath(3)); //   same-chunk dedup
  imports(QUOTED_IMPORTER, QUOTED_TARGET); // quoted-path escaping
  imports(CROSS_CHUNK_IMPORTER, targetPath(1)); // chunk 1 —
  imports(CROSS_CHUNK_IMPORTER, targetPath(TARGET_COUNT - 1)); //   cross-chunk dedup
  return buildTestGraph(nodes, rels);
}

withTestLbugDB('query-importers-batch', (handle) => {
  describe('queryImportersBatch (batched importer BFS, #2409)', () => {
    it('returns the full sorted, deduped importer set across the chunk boundary, dedups within a chunk, matches quoted targets, and no-ops on empty input', async () => {
      const { loadGraphToLbug, queryImportersBatch } =
        await import('../../src/core/lbug/lbug-adapter.js');

      await loadGraphToLbug(buildFixtureGraph(), '/tmp/repo', path.dirname(handle.dbPath));

      // One call over all 201 targets → two chunked queries. The result is
      // the union of both chunks, deduped (CROSS_CHUNK_IMPORTER matched in
      // BOTH chunks, appears once) and sorted (SECOND_CHUNK_IMPORTER was
      // discovered by the LAST query yet sorts first).
      const onChunkFailure = vi.fn();
      const importers = await queryImportersBatch(buildTargetList(), { onChunkFailure });
      expect(importers).toEqual([
        SECOND_CHUNK_IMPORTER,
        SAME_CHUNK_IMPORTER,
        QUOTED_IMPORTER,
        CROSS_CHUNK_IMPORTER,
      ]);
      expect(onChunkFailure).not.toHaveBeenCalled();

      // Multi-target dedup WITHIN a single chunk: one importer of two
      // targets in the same IN-list appears once.
      await expect(queryImportersBatch([targetPath(2), targetPath(3)])).resolves.toEqual([
        SAME_CHUNK_IMPORTER,
      ]);

      // Quoted-path target: the list literal is escaped, not injected.
      await expect(queryImportersBatch([QUOTED_TARGET])).resolves.toEqual([QUOTED_IMPORTER]);

      // Empty targets → [] without touching the DB (zero chunks).
      await expect(queryImportersBatch([])).resolves.toEqual([]);
    }, 120_000);
  });
});

withTestLbugDB('query-importers-batch-module-members', (handle) => {
  describe('queryImportersBatch — module co-members (#3355)', () => {
    it('returns files sharing a module-membership hub, and ignores other File->Module edges', async () => {
      const { loadGraphToLbug, queryImportersBatch } =
        await import('../../src/core/lbug/lbug-adapter.js');
      const { MODULE_MEMBERSHIP_REASON } = await import('../../src/core/graph/edge-reasons.js');

      const file = (fp: string): TestNodeInput => ({
        id: `File:${fp}`,
        label: 'File',
        name: path.basename(fp),
        filePath: fp,
      });
      const nodes: TestNodeInput[] = [
        file('Net/A.swift'),
        file('Net/B.swift'),
        file('Net/C.swift'),
        file('Login/D.swift'),
        file('jobs/one.jcl'),
        file('jobs/two.jcl'),
        { id: 'Module:swift:Net', label: 'Module', name: 'Net', filePath: 'Net' },
        { id: 'Module:swift:Login', label: 'Module', name: 'Login', filePath: 'Login' },
        { id: 'Module:proc', label: 'Module', name: 'PROC', filePath: 'jobs/proc.jcl' },
      ];
      const member = (fp: string, moduleId: string): TestRelInput => ({
        sourceId: `File:${fp}`,
        targetId: moduleId,
        type: 'IMPORTS',
        reason: MODULE_MEMBERSHIP_REASON,
      });
      const rels: TestRelInput[] = [
        member('Net/A.swift', 'Module:swift:Net'),
        member('Net/B.swift', 'Module:swift:Net'),
        member('Net/C.swift', 'Module:swift:Net'),
        member('Login/D.swift', 'Module:swift:Login'),
        // Two JCL jobs including the same PROC are not co-dependent.
        {
          sourceId: 'File:jobs/one.jcl',
          targetId: 'Module:proc',
          type: 'IMPORTS',
          reason: 'jcl-include',
        },
        {
          sourceId: 'File:jobs/two.jcl',
          targetId: 'Module:proc',
          type: 'IMPORTS',
          reason: 'jcl-include',
        },
      ];
      await loadGraphToLbug(buildTestGraph(nodes, rels), '/tmp/repo', path.dirname(handle.dbPath));

      await expect(queryImportersBatch(['Net/B.swift'])).resolves.toEqual([
        'Net/A.swift',
        'Net/C.swift',
      ]);
      await expect(queryImportersBatch(['Login/D.swift'])).resolves.toEqual([]);
      await expect(queryImportersBatch(['jobs/one.jcl'])).resolves.toEqual([]);
    }, 120_000);
  });
});

// Dedicated trailing block: the DROP below poisons this DB for any further
// CodeRelation query, so no other test may share it.
withTestLbugDB('query-importers-batch-failure', () => {
  describe('queryImportersBatch failure branch (tri-review 4669518496 P2-5)', () => {
    it('degrades to [] and reports each dropped chunk via onChunkFailure with the engine error', async () => {
      const { executeQuery, queryImportersBatch } =
        await import('../../src/core/lbug/lbug-adapter.js');

      // Real engine failure, not a mock: DROP TABLE is supported by
      // @ladybugdb/core 0.18.0, and every subsequent MATCH on the table
      // fails with `Binder exception: Table CodeRelation does not exist.`
      await executeQuery('DROP TABLE CodeRelation');

      const failures: Array<{ chunkIndex: number; chunkSize: number; err: unknown }> = [];
      const importers = await queryImportersBatch(buildTargetList(), {
        onChunkFailure: (chunkIndex, chunkSize, err) =>
          failures.push({ chunkIndex, chunkSize, err }),
      });

      // Degrade-don't-fail: no throw, empty expansion…
      expect(importers).toEqual([]);
      // …but LOUD: one callback per dropped chunk (200 + 1 paths).
      expect(failures.map(({ chunkIndex, chunkSize }) => ({ chunkIndex, chunkSize }))).toEqual([
        { chunkIndex: 0, chunkSize: DELETE_FILES_CHUNK_SIZE },
        { chunkIndex: 1, chunkSize: 1 },
      ]);
      expect(
        failures.map((f) => String((f.err as { message?: unknown }).message ?? f.err)),
      ).toEqual([
        expect.stringContaining('Table CodeRelation does not exist'),
        expect.stringContaining('Table CodeRelation does not exist'),
      ]);
    }, 120_000);
  });
});
