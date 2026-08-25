import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONST_SCHEMA } from '../../src/core/lbug/schema.js';

interface FakeQueryResult {
  getAll: () => Promise<unknown[]>;
  close: () => void;
}

function makeConfigMock() {
  const queries: string[] = [];
  const queryResult: FakeQueryResult = { getAll: async () => [], close: vi.fn() };
  const conn = {
    query: vi.fn(async (cypher: string) => {
      queries.push(cypher);
      return queryResult;
    }),
    close: vi.fn(async () => {}),
  };
  const db = { close: vi.fn(async () => {}) };
  return {
    queries,
    mock: {
      openLbugConnection: vi.fn(async () => ({ db, conn })),
      closeLbugConnection: async () => {
        await conn.close();
        await db.close();
      },
      isDbBusyError: vi.fn(() => false),
      isOpenRetryExhausted: vi.fn(() => false),
      isWalCorruptionError: vi.fn(() => false),
      toNativeSafePath: (value: string) => value,
      resolveNativeSafeStorageDir: (value: string) => value,
      WAL_RECOVERY_SUGGESTION: 'run analyze --force',
      waitForWindowsHandleRelease: vi.fn(async () => true),
    },
  };
}

const endpoint = {
  id: 'Const:src/endpoints.ts:getUser',
  name: 'getUser',
  filePath: 'src/endpoints.ts',
  startLine: 1,
  endLine: 3,
  isExported: true,
  content: 'query({ handler: getUser })',
  convexEndpointFactory: 'query',
};

describe('Convex endpoint metadata persistence contract', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-config.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('keeps the Const schema and COPY column list aligned', async () => {
    const { getCopyQuery } = await import('../../src/core/lbug/lbug-adapter.js');
    const copyQuery = getCopyQuery('Const', '/tmp/const.csv');

    expect(CONST_SCHEMA).toContain('convexEndpointFactory STRING');
    expect(CONST_SCHEMA).not.toContain('isExported BOOLEAN');
    expect(copyQuery).toContain('content, description, convexEndpointFactory');
    expect(copyQuery).not.toContain('isExported');
  });

  it('persists the property through single-node CREATE', async () => {
    const { mock, queries } = makeConfigMock();
    vi.doMock('../../src/core/lbug/lbug-config.js', () => mock);
    const { insertNodeToLbug } = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(insertNodeToLbug('Const', endpoint, '/tmp/convex-create/lbug')).resolves.toBe(
      true,
    );

    const createQuery = queries.find((query) => query.startsWith('CREATE (n:Const'));
    expect(createQuery).toContain("convexEndpointFactory: 'query'");
    expect(createQuery).not.toContain('isExported');
  });

  it('persists the property through incremental MERGE', async () => {
    const { mock, queries } = makeConfigMock();
    vi.doMock('../../src/core/lbug/lbug-config.js', () => mock);
    const { batchInsertNodesToLbug } = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(
      batchInsertNodesToLbug([{ label: 'Const', properties: endpoint }], '/tmp/convex-merge/lbug'),
    ).resolves.toEqual({ inserted: 1, failed: 0 });

    const mergeQuery = queries.find((query) => query.startsWith('MERGE (n:Const'));
    expect(mergeQuery).toContain("n.convexEndpointFactory = 'query'");
    expect(mergeQuery).not.toContain('isExported');
  });
});
