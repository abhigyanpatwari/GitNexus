/**
 * Integration test: PARALLEL=false is a load-bearing correctness invariant for
 * the bulk-COPY persistence path (#2203 — the "parallelized emit" follow-up).
 *
 * Issue #2203 asked us to investigate parallelizing emit. The most obvious
 * lever — LadybugDB's intra-COPY parallel CSV reader (`PARALLEL=true`, the
 * Kuzu default) — is UNSAFE for our data: that reader splits the file into byte
 * ranges parsed concurrently and cannot find line boundaries when a quoted
 * field contains an embedded newline (upstream kuzudb/kuzu#5778, still open;
 * error text "Quoted newlines are not supported in parallel CSV reader. Please
 * specify PARALLEL=FALSE"). Our `content`/`text` columns hold source code, so
 * quoted multiline fields are guaranteed. PARALLEL=false is therefore MANDATORY,
 * not conservative — this test locks that in two ways:
 *
 *  1. Live-DB proof — a node whose `text` carries embedded newlines AND quotes
 *     round-trips byte-exact through the real csv-emit → COPY → query path.
 *     If anyone flips PARALLEL=true, the parallel reader mis-parses this row and
 *     the assertion fails loudly. (An edge also round-trips, exercising the rel
 *     COPY path, which uses the same PARALLEL=false option.)
 *  2. Static guard — the generated COPY query strings still carry PARALLEL=false,
 *     giving a crisp failure independent of a live DB.
 *
 * Needs a real LadybugDB connection (initLbug), so it lives under integration.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { NODE_TABLES } from 'gitnexus-shared';
import { buildTestGraph } from '../helpers/test-graph.js';

let tmpBase: string;
let storagePath: string;
let dbPath: string;

// A BasicBlock `text` with the exact hazard the parallel reader cannot handle:
// embedded newlines INSIDE a field that also contains double-quotes. After
// escapeCSVField this becomes a quoted multiline CSV field.
const HAZARD_TEXT = 'const msg = "line one";\nconst other = "she said \\"hi\\"";\nreturn msg;';
const BB1 = 'BasicBlock:src/hazard.ts:0';
const BB2 = 'BasicBlock:src/hazard.ts:1';

beforeAll(async () => {
  // mkdtemp (not a predictable os.tmpdir join) + the `gitnexus-lbug-` prefix
  // that TEST_FIXTURE_PREFIXES recognizes for the stale-sidecar sweep.
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lbug-copy-parallel-'));
  storagePath = path.join(tmpBase, '.gitnexus');
  dbPath = path.join(storagePath, 'lbug');
  await fs.mkdir(dbPath, { recursive: true });

  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  await adapter.initLbug(dbPath);

  const graph = buildTestGraph(
    [
      {
        id: BB1,
        label: 'BasicBlock',
        name: '',
        filePath: 'src/hazard.ts',
        startLine: 1,
        endLine: 3,
        extra: { text: HAZARD_TEXT },
      },
      {
        id: BB2,
        label: 'BasicBlock',
        name: '',
        filePath: 'src/hazard.ts',
        startLine: 4,
        endLine: 4,
        extra: { text: 'sink(msg);' },
      },
    ],
    [{ sourceId: BB1, targetId: BB2, type: 'CFG', reason: 'cfg-edge' }],
  );

  await adapter.loadGraphToLbug(graph, tmpBase, storagePath);
});

afterAll(async () => {
  try {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug();
  } catch {
    /* may not have opened */
  }
  if (tmpBase) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rm(tmpBase, { recursive: true, force: true });
        return;
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
});

describe('PARALLEL=false correctness invariant (#2203 / kuzudb/kuzu#5778)', () => {
  it('a multiline-quoted content field round-trips byte-exact through COPY', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const rows = await adapter.executeQuery(
      `MATCH (n:BasicBlock {id: '${BB1}'}) RETURN n.text AS text`,
    );
    expect(rows).toHaveLength(1);
    // Byte-exact: the embedded newlines and the doubled quotes survived the
    // quoted-field round-trip. PARALLEL=true would have mis-split this row.
    expect(rows[0].text).toBe(HAZARD_TEXT);
  });

  it('an edge round-trips through the relationship COPY path (same PARALLEL=false)', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const rows = await adapter.executeQuery(
      "MATCH (:BasicBlock)-[r:CodeRelation {type: 'CFG'}]->(:BasicBlock) RETURN count(r) AS c",
    );
    expect(Number(rows[0].c)).toBe(1);
  });

  it('every generated node COPY query statically carries PARALLEL=false', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    expect(adapter.COPY_CSV_OPTS).toContain('PARALLEL=false');
    expect(adapter.COPY_CSV_OPTS).not.toContain('PARALLEL=true');
    for (const table of NODE_TABLES) {
      const q = adapter.getCopyQuery(table, '/tmp/x.csv');
      expect(q, `${table} COPY must keep PARALLEL=false`).toContain('PARALLEL=false');
      expect(q, `${table} COPY must not enable PARALLEL`).not.toContain('PARALLEL=true');
    }
  });
});
