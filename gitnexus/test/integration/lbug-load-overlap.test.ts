/**
 * Integration test: the node-COPY ‖ relationship-emit overlap (#2203) persists
 * BYTE-IDENTICAL graph content to the legacy strictly-serial path.
 *
 * This is the acceptance gate for the #2203 "parallelized emit" follow-up: the
 * overlap reorders *scheduling* (node COPY runs while relationship CSVs are
 * still being written), never the data. We prove that by loading one fixture
 * graph into two fresh DBs — once via the default overlap path, once via the
 * GITNEXUS_SERIAL_LBUG_LOAD=1 escape hatch — and asserting the two databases are
 * content-equivalent: same per-table node counts, same per-type edge counts,
 * same multiline `content`/`text` field bytes, and the same loadGraphToLbug
 * return accounting.
 *
 * Needs a real LadybugDB connection (initLbug), so it lives under integration.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { buildTestGraph } from '../helpers/test-graph.js';

let tmpBase: string;
let repoDir: string;

// Source-code-shaped content with embedded newlines AND quotes — the exact
// shape PARALLEL=false exists to handle. Read from disk for the File node and
// carried inline for the BasicBlock node, so both content sources are checked.
const FILE_SRC = 'export function f() {\n  const s = "a,b\\"c";\n  return s;\n}\n';
const BB_TEXT = 'if (cond) {\n  log("x = " + x);\n}\nreturn "done";';

const BB1 = 'BasicBlock:src/a.ts:0';
const BB2 = 'BasicBlock:src/a.ts:1';

const NODE_TABLES_CHECKED = ['File', 'Function', 'Class', 'BasicBlock'] as const;
const EDGE_TYPES_CHECKED = ['DEFINES', 'CALLS', 'CFG', 'REACHING_DEF'] as const;

const buildFixture = () =>
  buildTestGraph(
    [
      { id: 'File:src/a.ts', label: 'File', name: 'a.ts', filePath: 'src/a.ts' },
      {
        id: 'Function:src/a.ts:f:1',
        label: 'Function',
        name: 'f',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 4,
        isExported: true,
      },
      {
        id: 'Class:src/a.ts:C:6',
        label: 'Class',
        name: 'C',
        filePath: 'src/a.ts',
        startLine: 6,
        endLine: 8,
      },
      {
        id: BB1,
        label: 'BasicBlock',
        name: '',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 3,
        extra: { text: BB_TEXT },
      },
      { id: BB2, label: 'BasicBlock', name: '', filePath: 'src/a.ts', startLine: 4, endLine: 4 },
    ],
    [
      { sourceId: 'File:src/a.ts', targetId: 'Function:src/a.ts:f:1', type: 'DEFINES' },
      { sourceId: 'File:src/a.ts', targetId: 'Class:src/a.ts:C:6', type: 'DEFINES' },
      { sourceId: 'Function:src/a.ts:f:1', targetId: 'Class:src/a.ts:C:6', type: 'CALLS' },
      { sourceId: BB1, targetId: BB2, type: 'CFG', reason: 'cfg' },
      { sourceId: BB1, targetId: BB2, type: 'REACHING_DEF', reason: 's' },
    ],
  );

interface Snapshot {
  nodeCounts: Record<string, number>;
  edgeCounts: Record<string, number>;
  bbText: string | undefined;
  fileContent: string | undefined;
  ret: { insertedRels: number; skippedRels: number; warnings: string[] };
}

const snapshotDb = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: any,
  ret: Snapshot['ret'],
): Promise<Snapshot> => {
  const nodeCounts: Record<string, number> = {};
  for (const t of NODE_TABLES_CHECKED) {
    const rows = await adapter.executeQuery(`MATCH (n:\`${t}\`) RETURN count(n) AS c`);
    nodeCounts[t] = Number(rows[0].c);
  }
  const edgeCounts: Record<string, number> = {};
  for (const ty of EDGE_TYPES_CHECKED) {
    const rows = await adapter.executeQuery(
      `MATCH ()-[r:CodeRelation {type: '${ty}'}]->() RETURN count(r) AS c`,
    );
    edgeCounts[ty] = Number(rows[0].c);
  }
  const bbRows = await adapter.executeQuery(
    `MATCH (n:BasicBlock {id: '${BB1}'}) RETURN n.text AS text`,
  );
  const fileRows = await adapter.executeQuery(
    "MATCH (n:File {id: 'File:src/a.ts'}) RETURN n.content AS content",
  );
  return {
    nodeCounts,
    edgeCounts,
    bbText: bbRows[0]?.text,
    fileContent: fileRows[0]?.content,
    ret,
  };
};

const loadAndSnapshot = async (label: string, serial: boolean): Promise<Snapshot> => {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const storagePath = path.join(tmpBase, label, '.gitnexus');
  const dbPath = path.join(storagePath, 'lbug');
  await fs.mkdir(dbPath, { recursive: true });

  if (serial) process.env.GITNEXUS_SERIAL_LBUG_LOAD = '1';
  else delete process.env.GITNEXUS_SERIAL_LBUG_LOAD;
  try {
    await adapter.initLbug(dbPath);
    const ret = await adapter.loadGraphToLbug(buildFixture(), repoDir, storagePath);
    const snap = await snapshotDb(adapter, {
      insertedRels: ret.insertedRels,
      skippedRels: ret.skippedRels,
      warnings: ret.warnings,
    });
    await adapter.closeLbug();
    return snap;
  } finally {
    delete process.env.GITNEXUS_SERIAL_LBUG_LOAD;
  }
};

let overlapSnap: Snapshot;
let serialSnap: Snapshot;

beforeAll(async () => {
  // mkdtemp (not a predictable os.tmpdir join) — secure unique dir, and the
  // `gitnexus-lbug-` prefix is in TEST_FIXTURE_PREFIXES so the stale-sidecar
  // sweep recognizes it on Windows (lbug-config.ts).
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lbug-overlap-'));
  repoDir = path.join(tmpBase, 'repo');
  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'src', 'a.ts'), FILE_SRC);

  // Default overlap path first, then the serial escape hatch into a fresh DB.
  overlapSnap = await loadAndSnapshot('overlap', false);
  serialSnap = await loadAndSnapshot('serial', true);
});

afterAll(async () => {
  try {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug();
  } catch {
    /* may already be closed */
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

describe('node-COPY ‖ rel-emit overlap persists identical content (#2203)', () => {
  it('per-table node counts are identical between overlap and serial', () => {
    expect(overlapSnap.nodeCounts).toEqual(serialSnap.nodeCounts);
    // Sanity: the fixture actually populated every checked table.
    for (const t of NODE_TABLES_CHECKED) {
      expect(overlapSnap.nodeCounts[t], `${t} should have rows`).toBeGreaterThan(0);
    }
  });

  it('per-type edge counts are identical between overlap and serial', () => {
    expect(overlapSnap.edgeCounts).toEqual(serialSnap.edgeCounts);
    for (const ty of EDGE_TYPES_CHECKED) {
      expect(overlapSnap.edgeCounts[ty], `${ty} should have edges`).toBeGreaterThan(0);
    }
  });

  it('multiline content/text fields round-trip identically (byte-for-byte)', () => {
    // The #2203 invariant — overlap path == serial path — holds byte-for-byte
    // for both fields regardless of any content transform.
    expect(overlapSnap.bbText).toBe(serialSnap.bbText);
    expect(overlapSnap.fileContent).toBe(serialSnap.fileContent);

    // BasicBlock text is NOT FTS-indexed, so it round-trips raw (newlines kept).
    expect(overlapSnap.bbText).toBe(BB_TEXT);
    // File content IS FTS-indexed and is whitespace-normalized for the
    // space-only tokenizer (#2317): newlines/tabs collapse to single spaces.
    // So it round-trips as the source with intra-text whitespace flattened,
    // not byte-identical to the original multiline source.
    expect(overlapSnap.fileContent).toBe(FILE_SRC.replace(/[\r\n\t]+/g, ' '));
  });

  it('loadGraphToLbug accounting (insertedRels/skippedRels/warnings) is identical', () => {
    expect(overlapSnap.ret).toEqual(serialSnap.ret);
    expect(overlapSnap.ret.insertedRels).toBe(5);
    expect(overlapSnap.ret.skippedRels).toBe(0);
    expect(overlapSnap.ret.warnings).toEqual([]);
  });
});
