/**
 * Integration Tests: CodeRelation `source` column round-trip (WI-1, #159 P3 Mode A)
 *
 * Verifies the new 7th `source` column on CodeRelation survives the
 * full loadGraphToLbug pipeline (CSV → COPY) and that every row in
 * the table is non-NULL after a default-path round-trip. Also
 * verifies the explicit-source path (lsp-corrected) round-trips
 * through the same pipeline.
 *
 * The fallback CREATE path is tested by exercising `fallbackRelationshipInserts`
 * indirectly: when COPY is forced to fail for a rel pair, the adapter
 * routes the rows through the regex/CREATE path. We trigger that
 * by making COPY fail (mocked connection) — the unit-level test of
 * the regex is the csv-generator unit suite.
 *
 * Scope: this file lives under `lbug-db` project (vitest.config.ts)
 * and uses the shared global DB. The lifecycle wrapper clears all
 * data first, then seeds, then runs.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import path from 'path';
import lbug from '@ladybugdb/core';
import { withTestLbugDB } from '../../helpers/test-indexed-db.js';
import { buildTestGraph } from '../../helpers/test-graph.js';

// REL_TABLE_NAME as used in the COPY query string (no backticks).
const REL_TABLE_NAME_STR = 'CodeRelation';

/**
 * Wipe all data and CodeRelation rows from the shared DB. We do this
 * per-test (not per-file) so the assertions on `toHaveLength(N)` are
 * self-contained — the wrapper initializes the lbug adapter once
 * for the file, and tests share the same connection.
 */
async function clearData(): Promise<void> {
  const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
  for (const t of ['File', 'Folder', 'Function', 'Class', 'Method', 'CodeElement', 'Community', 'Process', 'Route']) {
    try { await adapter.executeQuery(`MATCH (n:\`${t}\`) DETACH DELETE n`); } catch { /* table may not exist yet */ }
  }
  try { await adapter.executeQuery(`MATCH ()-[r:CodeRelation]->() DELETE r`); } catch { /* empty */ }
}

withTestLbugDB('source-column-roundtrip', (handle) => {
  it('default-path: every CodeRelation row has source="heuristic" after a loadGraphToLbug round-trip', async () => {
    await clearData();
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
    const { loadGraphToLbug } = adapter;

    // Build a small graph with 2 Files + 2 Functions + 2 CALLS edges,
    // none of which carry an explicit `source`. The serializer must
    // default every row to 'heuristic' and the COPY path must persist
    // that value (no NULL).
    const graph = buildTestGraph(
      [
        { id: 'File:src/a.ts', label: 'File', name: 'a.ts', filePath: 'src/a.ts' },
        { id: 'File:src/b.ts', label: 'File', name: 'b.ts', filePath: 'src/b.ts' },
        { id: 'Function:src/a.ts:alpha:1', label: 'Function', name: 'alpha', filePath: 'src/a.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'Function:src/b.ts:beta:1', label: 'Function', name: 'beta', filePath: 'src/b.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [
        { sourceId: 'Function:src/a.ts:alpha:1', targetId: 'Function:src/b.ts:beta:1', type: 'CALLS' },
        { sourceId: 'Function:src/b.ts:beta:1', targetId: 'Function:src/a.ts:alpha:1', type: 'CALLS' },
      ],
    );

    const storagePath = path.join(handle.tmpHandle.dbPath, 'wi1-storage-default');
    const { mkdir } = await import('fs/promises');
    await mkdir(storagePath, { recursive: true });

    const result = await loadGraphToLbug(graph, '/test/repo', storagePath);
    expect(result.success).toBe(true);
    expect(result.insertedRels).toBe(2);

    // Query the table: every row must have a non-NULL `source`.
    const rows = await adapter.executeQuery(
      'MATCH ()-[r:CodeRelation]->() RETURN r.source AS source',
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const source = (row as any).source ?? (row as any)[0];
      expect(source).toBe('heuristic');
    }
  });

  it('explicit-source: a "lsp-corrected" tag round-trips through COPY and lands in the table verbatim', async () => {
    await clearData();
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
    const { loadGraphToLbug } = adapter;

    const graph = buildTestGraph(
      [
        { id: 'File:src/x.ts', label: 'File', name: 'x.ts', filePath: 'src/x.ts' },
        { id: 'File:src/y.ts', label: 'File', name: 'y.ts', filePath: 'src/y.ts' },
        { id: 'Function:src/x.ts:foo:1', label: 'Function', name: 'foo', filePath: 'src/x.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'Function:src/y.ts:bar:1', label: 'Function', name: 'bar', filePath: 'src/y.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [],
    );

    // addRelationship with the explicit `source` value (buildTestGraph
    // does not pass through the new optional field).
    graph.addRelationship({
      id: 'r-corrected',
      sourceId: 'Function:src/x.ts:foo:1',
      targetId: 'Function:src/y.ts:bar:1',
      type: 'CALLS',
      confidence: 0.7,
      reason: '',
      step: 0,
      source: 'lsp-corrected',
    });

    const storagePath = path.join(handle.tmpHandle.dbPath, 'wi1-storage-corrected');
    const { mkdir } = await import('fs/promises');
    await mkdir(storagePath, { recursive: true });

    const result = await loadGraphToLbug(graph, '/test/repo', storagePath);
    expect(result.success).toBe(true);
    expect(result.insertedRels).toBe(1);

    const rows = await adapter.executeQuery(
      'MATCH ()-[r:CodeRelation {type: "CALLS"}]->() RETURN r.source AS source',
    );
    expect(rows).toHaveLength(1);
    const source = (rows[0] as any).source ?? (rows[0] as any)[0];
    expect(source).toBe('lsp-corrected');
  });

  it('mixed batch: default-source + explicit-source rows both round-trip with correct values', async () => {
    await clearData();
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
    const { loadGraphToLbug } = adapter;

    const graph = buildTestGraph(
      [
        { id: 'File:src/p.ts', label: 'File', name: 'p.ts', filePath: 'src/p.ts' },
        { id: 'File:src/q.ts', label: 'File', name: 'q.ts', filePath: 'src/q.ts' },
        { id: 'File:src/r.ts', label: 'File', name: 'r.ts', filePath: 'src/r.ts' },
        { id: 'Function:src/p.ts:f1:1', label: 'Function', name: 'f1', filePath: 'src/p.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'Function:src/q.ts:f2:1', label: 'Function', name: 'f2', filePath: 'src/q.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'Function:src/r.ts:f3:1', label: 'Function', name: 'f3', filePath: 'src/r.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [
        { sourceId: 'Function:src/p.ts:f1:1', targetId: 'Function:src/q.ts:f2:1', type: 'CALLS' },
      ],
    );
    // One heuristic-default, one lsp-confirmed, one lsp-recall — covers
    // the full 4-value enum minus 'lsp-corrected' (covered by the test
    // above).
    graph.addRelationship({
      id: 'r-confirmed', sourceId: 'Function:src/q.ts:f2:1', targetId: 'Function:src/p.ts:f1:1',
      type: 'CALLS', confidence: 0.7, reason: '', source: 'lsp-confirmed',
    });
    graph.addRelationship({
      id: 'r-recall', sourceId: 'Function:src/r.ts:f3:1', targetId: 'Function:src/p.ts:f1:1',
      type: 'CALLS', confidence: 0.7, reason: '', source: 'lsp-recall',
    });

    const storagePath = path.join(handle.tmpHandle.dbPath, 'wi1-storage-mixed');
    const { mkdir } = await import('fs/promises');
    await mkdir(storagePath, { recursive: true });

    const result = await loadGraphToLbug(graph, '/test/repo', storagePath);
    expect(result.success).toBe(true);
    expect(result.insertedRels).toBe(3);

    const rows = await adapter.executeQuery(
      'MATCH ()-[r:CodeRelation {type: "CALLS"}]->() RETURN r.source AS source',
    );
    expect(rows).toHaveLength(3);
    const sources = rows.map((row: any) => row.source ?? row[0]);
    expect(sources).toEqual(expect.arrayContaining(['heuristic', 'lsp-confirmed', 'lsp-recall']));
    // No NULLs.
    for (const s of sources) {
      expect(s).toBeTruthy();
    }
  });
});

/**
 * B4 — AC-9 fallback-CREATE integration
 *
 * Forces every `COPY CodeRelation` call to throw (both the primary attempt
 * and the IGNORE_ERRORS retry use `conn.query` and both contain
 * `COPY CodeRelation`). This routes the lines through
 * `fallbackRelationshipInserts` — the regex-based 7th-capture + CREATE path.
 *
 * Asserts that `r.source` is:
 *  - 'heuristic'     for a row that carried NO explicit source (default path)
 *  - 'lsp-corrected' for a row that carried an explicit source (explicit path)
 *
 * If the 7th capture or the source persistence in the CREATE were broken,
 * the `r.source` values would be NULL or 'heuristic' for both rows — the
 * test would fail because `expect(source).toBe('lsp-corrected')` asserts
 * a distinct, non-default value.
 */
withTestLbugDB('source-column-roundtrip-fallback', (handle) => {
  let querySpy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    // Always restore the prototype spy — even if the test throws — so
    // subsequent tests run against a real connection.
    querySpy?.mockRestore();
    querySpy = null;
  });

  it('fallback-CREATE path: source persists non-NULL for both default ("heuristic") and explicit ("lsp-corrected") rows', async () => {
    await clearData();
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
    const { loadGraphToLbug } = adapter;

    // Build a graph with two CALLS edges:
    //   • one with NO explicit source  → should persist as 'heuristic'
    //   • one with source='lsp-corrected' → must persist verbatim
    const graph = buildTestGraph(
      [
        { id: 'File:src/fb_a.ts', label: 'File', name: 'fb_a.ts', filePath: 'src/fb_a.ts' },
        { id: 'File:src/fb_b.ts', label: 'File', name: 'fb_b.ts', filePath: 'src/fb_b.ts' },
        { id: 'Function:src/fb_a.ts:alpha:1', label: 'Function', name: 'alpha', filePath: 'src/fb_a.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'Function:src/fb_b.ts:beta:1',  label: 'Function', name: 'beta',  filePath: 'src/fb_b.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      // default-source row (no explicit source — serializer defaults to 'heuristic')
      [
        { sourceId: 'Function:src/fb_a.ts:alpha:1', targetId: 'Function:src/fb_b.ts:beta:1', type: 'CALLS' },
      ],
    );

    // explicit-source row: 'lsp-corrected' must survive the 7th regex capture
    graph.addRelationship({
      id: 'r-fb-corrected',
      sourceId: 'Function:src/fb_b.ts:beta:1',
      targetId: 'Function:src/fb_a.ts:alpha:1',
      type: 'CALLS',
      confidence: 0.7,
      reason: '',
      source: 'lsp-corrected',
    });

    // Intercept conn.query at the prototype level.
    // Throw for any COPY CodeRelation statement (both primary + IGNORE_ERRORS
    // retry contain that string), pass through everything else (node COPYs,
    // MATCH/CREATE, MATCH/DELETE, MATCH/RETURN).
    const originalQuery = lbug.Connection.prototype.query;
    querySpy = vi.spyOn(lbug.Connection.prototype, 'query').mockImplementation(
      function (this: lbug.Connection, cypher: string, ...rest: unknown[]) {
        if (typeof cypher === 'string' && cypher.includes(`COPY ${REL_TABLE_NAME_STR}`)) {
          throw new Error('[test] forced COPY failure to exercise fallback path');
        }
        // All other queries (node COPY, MATCH/CREATE, MATCH/RETURN, DELETE) go
        // through the real implementation.
        return originalQuery.call(this, cypher, ...rest);
      },
    );

    const storagePath = path.join(handle.tmpHandle.dbPath, 'wi1-storage-fallback');
    const { mkdir } = await import('fs/promises');
    await mkdir(storagePath, { recursive: true });

    // loadGraphToLbug must succeed even when COPY for rels fails — the
    // fallback path must handle both rows and return success.
    const result = await loadGraphToLbug(graph, '/test/repo', storagePath);
    expect(result.success).toBe(true);
    // The adapter counts totalValidRels before the COPY attempts, so
    // insertedRels reflects the number of rows that entered the pipeline,
    // not just those that went through COPY.
    expect(result.insertedRels).toBe(2);

    // Restore the spy NOW so the subsequent executeQuery can reach the DB.
    querySpy.mockRestore();
    querySpy = null;

    // Verify both rows persisted by the CREATE path carry the correct source.
    const rows = await adapter.executeQuery(
      'MATCH ()-[r:CodeRelation {type: "CALLS"}]->() RETURN r.source AS source, r.confidence AS confidence',
    );
    expect(rows).toHaveLength(2);

    const sources = rows.map((row: any) => row.source ?? row[0]);

    // ── Critical assertions ──────────────────────────────────────────────────
    // If the 7th capture were absent (or the source field were not written in
    // the CREATE), BOTH rows would be NULL or one would silently become
    // 'heuristic'; neither assertion below could pass by accident.

    // 1. At least one row must carry the explicit 'lsp-corrected' tag.
    //    This fails if the regex doesn't capture the 7th column or the
    //    CREATE query omits the `source:` property.
    expect(sources).toContain('lsp-corrected');

    // 2. At least one row must carry the default 'heuristic' tag.
    //    This fails if the serializer-side default is dropped.
    expect(sources).toContain('heuristic');

    // 3. No NULLs / undefined / empty strings.
    for (const s of sources) {
      expect(s).toBeTruthy();
    }

    // 4. The 'lsp-corrected' row's source is exactly the string 'lsp-corrected'
    //    (not a truncated/mangled value from a broken regex capture).
    const correctedRow = rows.find((row: any) => (row.source ?? row[0]) === 'lsp-corrected');
    expect(correctedRow).toBeDefined();
    const correctedSource = (correctedRow as any).source ?? (correctedRow as any)[0];
    expect(correctedSource).toBe('lsp-corrected');
  });
});
