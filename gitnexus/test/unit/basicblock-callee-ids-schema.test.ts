/**
 * U4 (#2227 follow-up plan) — `BasicBlock.calleeIds` column wiring end-to-end.
 *
 * U3 (already committed) sets `node.properties.calleeIds` on every emitted
 * BasicBlock; U4 wires that property through the FIVE places the existing
 * `callees` column lives so it actually persists and reads back:
 *   1. schema DDL                (BASICBLOCK_SCHEMA)
 *   2. CSV header + row builder  (BASICBLOCK_CSV_HEADER / buildBasicBlockRow)
 *   3. bulk COPY column list     (getCopyQuery('BasicBlock'))
 *   4. single-node CREATE        (insertNodeToLbug)
 *   5. incremental MERGE         (batchInsertNodesToLbug)
 * plus the INCREMENTAL_SCHEMA_VERSION 2 → 3 bump (KTD5).
 *
 * `calleeIds` is added LAST in the CSV/COPY/CREATE/MERGE tuple, so the column
 * order MUST stay identical across header, COPY list, and row array — the
 * parity test below is the drift guard.
 *
 * The CSV/COPY/schema/version assertions are pure (no DB). The CREATE and MERGE
 * query-string assertions mock `lbug-config.js` to capture the executed cypher,
 * mirroring the established `lbug-adapter-wal-schema.test.ts` pattern (typed
 * fake `conn`/`db`, no `any`/`as any`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode, NodeProperties } from 'gitnexus-shared';
import { BASICBLOCK_CSV_HEADER, buildBasicBlockRow } from '../../src/core/lbug/csv-generator.js';
import { getCopyQuery } from '../../src/core/lbug/lbug-adapter.js';
import { BASICBLOCK_SCHEMA } from '../../src/core/lbug/schema.js';
import { INCREMENTAL_SCHEMA_VERSION } from '../../src/storage/repo-manager.js';

// ── helpers ─────────────────────────────────────────────────────────────────

/** Build a typed BasicBlock GraphNode with the given extra properties. */
const basicBlock = (id: string, props: Partial<NodeProperties>): GraphNode => ({
  id,
  label: 'BasicBlock',
  properties: {
    name: '', // BasicBlock has no name column; identified by id + span
    filePath: 'src/a.ts',
    startLine: 1,
    endLine: 3,
    text: 'foo(); bar();',
    ...props,
  },
});

/** Parse the COPY column tuple out of `COPY Table(a, b, c) FROM "…"`. */
const copyColumns = (copyQuery: string): string[] => {
  const open = copyQuery.indexOf('(');
  const close = copyQuery.indexOf(')', open);
  return copyQuery
    .slice(open + 1, close)
    .split(',')
    .map((c) => c.trim());
};

// ── 1. CSV header / row builder (pure) ────────────────────────────────────────

describe('BasicBlock calleeIds — CSV header + row builder', () => {
  it('header lists calleeIds LAST, after callees', () => {
    expect(BASICBLOCK_CSV_HEADER).toBe('id,filePath,startLine,endLine,text,callees,calleeIds');
    const cols = BASICBLOCK_CSV_HEADER.split(',');
    expect(cols[cols.length - 1]).toBe('calleeIds');
    expect(cols[cols.length - 2]).toBe('callees');
  });

  it('round-trip: calleeIds lands in the column the header names for it', () => {
    const node = basicBlock('BasicBlock:src/a.ts:0', {
      callees: 'foo bar',
      calleeIds: 'id1 id2',
    });
    const headerCols = BASICBLOCK_CSV_HEADER.split(',');
    const rowCells = buildBasicBlockRow(node).split(',');

    // Same arity as the header → positional column match is meaningful.
    expect(rowCells).toHaveLength(headerCols.length);
    const calleeIdsIdx = headerCols.indexOf('calleeIds');
    const calleesIdx = headerCols.indexOf('callees');
    // escapeCSVField always wraps the cell in double quotes; the space-joined
    // id list contains no comma, so the cell is a single CSV column.
    expect(rowCells[calleeIdsIdx]).toBe('"id1 id2"');
    expect(rowCells[calleesIdx]).toBe('"foo bar"');
  });

  it('empty default: a node with no calleeIds property → empty cell, not "undefined"', () => {
    const node = basicBlock('BasicBlock:src/a.ts:1', { callees: 'foo bar' });
    const headerCols = BASICBLOCK_CSV_HEADER.split(',');
    const rowCells = buildBasicBlockRow(node).split(',');
    const calleeIdsIdx = headerCols.indexOf('calleeIds');
    expect(rowCells[calleeIdsIdx]).toBe('""');
    expect(rowCells[calleeIdsIdx]).not.toContain('undefined');
  });
});

// ── 2. Header / COPY tuple / row array PARITY (drift guard) ────────────────────

describe('BasicBlock calleeIds — header/COPY/row column parity', () => {
  it('header column count == COPY tuple arity == row array length', () => {
    const headerCols = BASICBLOCK_CSV_HEADER.split(',');
    const copyCols = copyColumns(getCopyQuery('BasicBlock', '/tmp/bb.csv'));
    const rowCells = buildBasicBlockRow(
      basicBlock('BasicBlock:src/a.ts:0', { callees: 'foo', calleeIds: 'id1' }),
    ).split(',');

    // Exact counts (the drift guard): 7 columns through and through.
    expect(headerCols).toHaveLength(7);
    expect(copyCols).toHaveLength(7);
    expect(rowCells).toHaveLength(7);
    expect(copyCols).toHaveLength(headerCols.length);
    expect(rowCells).toHaveLength(headerCols.length);
  });

  it('COPY column order matches the CSV header order exactly', () => {
    const headerCols = BASICBLOCK_CSV_HEADER.split(',');
    const copyCols = copyColumns(getCopyQuery('BasicBlock', '/tmp/bb.csv'));
    expect(copyCols).toEqual(headerCols);
    expect(copyCols[copyCols.length - 1]).toBe('calleeIds');
  });
});

// ── 3. schema DDL + incremental version bump (pure) ───────────────────────────

describe('BasicBlock calleeIds — schema DDL + version bump', () => {
  it('BASICBLOCK_SCHEMA declares the calleeIds STRING column', () => {
    expect(BASICBLOCK_SCHEMA).toContain('callees STRING');
    expect(BASICBLOCK_SCHEMA).toContain('calleeIds STRING');
  });

  it('INCREMENTAL_SCHEMA_VERSION is at least 3 (calleeIds column bump, KTD5)', () => {
    // The exact value advances as later milestones add re-index-forcing changes
    // (v4 = CALL_SUMMARY, PDG FU-C). This guard pins the floor the calleeIds
    // column established; the v3→4 reuse-gate guard lives in its own test.
    expect(INCREMENTAL_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  });
});

// ── 4 + 5. CREATE / MERGE query strings carry the calleeIds assignment ─────────
//
// `insertNodeToLbug` (CREATE) and `batchInsertNodesToLbug` (MERGE) build their
// cypher inline and execute it via the `lbug-config.js` connection. Mock that
// module with a typed fake `conn` whose `query` records the cypher, then assert
// the recorded string contains the calleeIds assignment.

interface FakeQueryResult {
  getAll: () => Promise<unknown[]>;
  close: () => void;
}
interface FakeConn {
  query: (cypher: string) => Promise<FakeQueryResult>;
  close: () => Promise<void>;
}
interface FakeDb {
  close: () => Promise<void>;
}

const makeConfigMock = () => {
  const queries: string[] = [];
  const queryResult: FakeQueryResult = { getAll: async () => [], close: vi.fn() };
  const conn: FakeConn = {
    query: vi.fn(async (cypher: string) => {
      queries.push(cypher);
      return queryResult;
    }),
    close: vi.fn(async () => {}),
  };
  const db: FakeDb = { close: vi.fn(async () => {}) };
  const mock = {
    openLbugConnection: vi.fn(async () => ({ db, conn })),
    closeLbugConnection: async (handle: { conn: FakeConn; db: FakeDb }) => {
      await handle.conn.close();
      await handle.db.close();
    },
    isDbBusyError: vi.fn(() => false),
    isOpenRetryExhausted: vi.fn(() => false),
    isWalCorruptionError: vi.fn(() => false),
    toNativeSafePath: (p: string) => p,
    resolveNativeSafeStorageDir: (p: string) => p,
    WAL_RECOVERY_SUGGESTION: 'run analyze --force',
    waitForWindowsHandleRelease: vi.fn(async () => true),
  };
  return { mock, queries };
};

describe('BasicBlock calleeIds — CREATE / MERGE query strings', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-config.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('insertNodeToLbug CREATE assigns calleeIds (after callees)', async () => {
    vi.resetModules();
    const { mock, queries } = makeConfigMock();
    vi.doMock('../../src/core/lbug/lbug-config.js', () => mock);

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const ok = await adapter.insertNodeToLbug(
      'BasicBlock',
      {
        id: 'BasicBlock:src/a.ts:0',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 3,
        text: 'foo();',
        callees: 'foo',
        calleeIds: 'id1 id2',
      },
      '/tmp/gitnexus-bb-create/lbug',
    );

    expect(ok).toBe(true);
    const createQuery = queries.find((q) => q.startsWith('CREATE (n:BasicBlock'));
    expect(createQuery).toBeDefined();
    expect(createQuery).toContain("calleeIds: 'id1 id2'");
    expect(createQuery).toContain("callees: 'foo'");
    // calleeIds is the LAST assignment in the tuple (mirrors the column order).
    expect(createQuery?.indexOf('calleeIds:')).toBeGreaterThan(
      createQuery?.indexOf('callees:') ?? -1,
    );
  });

  it('insertNodeToLbug CREATE defaults a missing calleeIds to an empty string', async () => {
    vi.resetModules();
    const { mock, queries } = makeConfigMock();
    vi.doMock('../../src/core/lbug/lbug-config.js', () => mock);

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.insertNodeToLbug(
      'BasicBlock',
      {
        id: 'BasicBlock:src/a.ts:0',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 3,
        text: 'foo();',
        callees: 'foo',
      },
      '/tmp/gitnexus-bb-create-default/lbug',
    );

    const createQuery = queries.find((q) => q.startsWith('CREATE (n:BasicBlock'));
    expect(createQuery).toContain("calleeIds: ''");
    expect(createQuery).not.toContain('calleeIds: undefined');
  });

  it('batchInsertNodesToLbug MERGE sets n.calleeIds (after n.callees)', async () => {
    vi.resetModules();
    const { mock, queries } = makeConfigMock();
    vi.doMock('../../src/core/lbug/lbug-config.js', () => mock);

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const result = await adapter.batchInsertNodesToLbug(
      [
        {
          label: 'BasicBlock',
          properties: {
            id: 'BasicBlock:src/a.ts:0',
            filePath: 'src/a.ts',
            startLine: 1,
            endLine: 3,
            text: 'foo();',
            callees: 'foo',
            calleeIds: 'id1 id2',
          },
        },
      ],
      '/tmp/gitnexus-bb-merge/lbug',
    );

    expect(result.inserted).toBe(1);
    const mergeQuery = queries.find((q) => q.startsWith('MERGE (n:BasicBlock'));
    expect(mergeQuery).toBeDefined();
    expect(mergeQuery).toContain('n.calleeIds');
    expect(mergeQuery).toContain("n.calleeIds = 'id1 id2'");
    expect(mergeQuery).toContain("n.callees = 'foo'");
    expect(mergeQuery?.indexOf('n.calleeIds')).toBeGreaterThan(
      mergeQuery?.indexOf('n.callees') ?? -1,
    );
  });

  it('batchInsertNodesToLbug MERGE defaults a missing calleeIds to an empty string', async () => {
    vi.resetModules();
    const { mock, queries } = makeConfigMock();
    vi.doMock('../../src/core/lbug/lbug-config.js', () => mock);

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.batchInsertNodesToLbug(
      [
        {
          label: 'BasicBlock',
          properties: {
            id: 'BasicBlock:src/a.ts:0',
            filePath: 'src/a.ts',
            startLine: 1,
            endLine: 3,
            text: 'foo();',
            callees: 'foo',
          },
        },
      ],
      '/tmp/gitnexus-bb-merge-default/lbug',
    );

    const mergeQuery = queries.find((q) => q.startsWith('MERGE (n:BasicBlock'));
    expect(mergeQuery).toContain("n.calleeIds = ''");
    expect(mergeQuery).not.toContain('n.calleeIds = undefined');
  });
});
