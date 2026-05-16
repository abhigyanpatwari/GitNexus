import { afterEach, describe, expect, it, vi } from 'vitest';

describe('lbug adapter CHECKPOINT lifecycle', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-config.js');
    vi.doUnmock('../../src/core/lbug/extension-loader.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('drains and closes CHECKPOINT result before closing connection and database handles', async () => {
    vi.resetModules();

    const events: string[] = [];
    const checkpointResult = {
      getAll: vi.fn(async () => {
        events.push('checkpoint:getAll');
        return [];
      }),
      close: vi.fn(() => {
        events.push('checkpoint:close');
      }),
    };
    const genericResult = {
      getAll: vi.fn(async () => []),
      close: vi.fn(),
    };
    const conn = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'CHECKPOINT') {
          events.push('checkpoint:query');
          return checkpointResult;
        }
        return genericResult;
      }),
      close: vi.fn(async () => {
        events.push('conn:close');
      }),
    };
    const db = {
      close: vi.fn(async () => {
        events.push('db:close');
      }),
    };

    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: vi.fn(async () => ({ db, conn })),
      closeLbugConnection: vi.fn(async () => {}),
      isDbBusyError: vi.fn((err: unknown) => String(err).toLowerCase().includes('lock')),
      isOpenRetryExhausted: vi.fn(() => false),
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: vi.fn(async () => true),
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug('/tmp/gitnexus-lbug-checkpoint-lifecycle/lbug');

    events.length = 0;
    await adapter.closeLbug();

    expect(events).toEqual([
      'checkpoint:query',
      'checkpoint:getAll',
      'checkpoint:close',
      'conn:close',
      'db:close',
    ]);
  });

  it('closes normal query results after reading rows', async () => {
    vi.resetModules();

    const events: string[] = [];
    const queryResult = {
      getAll: vi.fn(async () => {
        events.push('query:getAll');
        return [{ id: 'file:a' }];
      }),
      close: vi.fn(() => {
        events.push('query:close');
      }),
    };
    const genericResult = {
      getAll: vi.fn(async () => []),
      close: vi.fn(),
    };
    const conn = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'MATCH (n:File) RETURN n.id AS id') {
          events.push('query:run');
          return queryResult;
        }
        return genericResult;
      }),
      close: vi.fn(async () => {}),
    };
    const db = {
      close: vi.fn(async () => {}),
    };

    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: vi.fn(async () => ({ db, conn })),
      closeLbugConnection: vi.fn(async () => {}),
      isDbBusyError: vi.fn((err: unknown) => String(err).toLowerCase().includes('lock')),
      isOpenRetryExhausted: vi.fn(() => false),
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: vi.fn(async () => true),
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug('/tmp/gitnexus-lbug-query-lifecycle/lbug');

    events.length = 0;
    await expect(adapter.executeQuery('MATCH (n:File) RETURN n.id AS id')).resolves.toEqual([
      { id: 'file:a' },
    ]);

    expect(events).toEqual(['query:run', 'query:getAll', 'query:close']);

    await adapter.closeLbug();
  });

  it('treats synchronous query result close errors as best-effort cleanup', async () => {
    vi.resetModules();

    const queryResult = {
      getAll: vi.fn(async () => [{ id: 'file:a' }]),
      close: vi.fn(() => {
        throw new Error('close failed');
      }),
    };
    const genericResult = {
      getAll: vi.fn(async () => []),
      close: vi.fn(),
    };
    const conn = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'MATCH (n:File) RETURN n.id AS id') {
          return queryResult;
        }
        return genericResult;
      }),
      close: vi.fn(async () => {}),
    };
    const db = {
      close: vi.fn(async () => {}),
    };

    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: vi.fn(async () => ({ db, conn })),
      closeLbugConnection: vi.fn(async () => {}),
      isDbBusyError: vi.fn((err: unknown) => String(err).toLowerCase().includes('lock')),
      isOpenRetryExhausted: vi.fn(() => false),
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: vi.fn(async () => true),
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug('/tmp/gitnexus-lbug-sync-close-lifecycle/lbug');

    await expect(adapter.executeQuery('MATCH (n:File) RETURN n.id AS id')).resolves.toEqual([
      { id: 'file:a' },
    ]);
    expect(queryResult.close).toHaveBeenCalledOnce();

    await adapter.closeLbug();
  });

  it('closes later query results when an earlier array result fails to read', async () => {
    vi.resetModules();

    const events: string[] = [];
    const firstResult = {
      getAll: vi.fn(async () => {
        events.push('first:getAll');
        throw new Error('read failed');
      }),
      close: vi.fn(() => {
        events.push('first:close');
      }),
    };
    const secondResult = {
      getAll: vi.fn(async () => {
        events.push('second:getAll');
        return [];
      }),
      close: vi.fn(() => {
        events.push('second:close');
      }),
    };
    const genericResult = {
      getAll: vi.fn(async () => []),
      close: vi.fn(),
    };
    const conn = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'MATCH (n:File) RETURN n.id AS id') {
          return [firstResult, secondResult];
        }
        return genericResult;
      }),
      close: vi.fn(async () => {}),
    };
    const db = {
      close: vi.fn(async () => {}),
    };

    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: vi.fn(async () => ({ db, conn })),
      closeLbugConnection: vi.fn(async () => {}),
      isDbBusyError: vi.fn((err: unknown) => String(err).toLowerCase().includes('lock')),
      isOpenRetryExhausted: vi.fn(() => false),
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: vi.fn(async () => true),
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug('/tmp/gitnexus-lbug-array-error-lifecycle/lbug');

    await expect(adapter.executeQuery('MATCH (n:File) RETURN n.id AS id')).rejects.toThrow(
      'read failed',
    );
    expect(events).toEqual(['first:getAll', 'first:close', 'second:getAll', 'second:close']);

    await adapter.closeLbug();
  });

  it('closes non-first stream query results when LadybugDB returns an array', async () => {
    vi.resetModules();

    const events: string[] = [];
    const firstResult = {
      hasNext: vi
        .fn()
        .mockImplementationOnce(() => {
          events.push('first:hasNext:true');
          return true;
        })
        .mockImplementationOnce(() => {
          events.push('first:hasNext:false');
          return false;
        }),
      getNext: vi.fn(async () => {
        events.push('first:getNext');
        return { id: 'file:a' };
      }),
      getAll: vi.fn(async () => {
        events.push('first:getAll');
        return [];
      }),
      close: vi.fn(() => {
        events.push('first:close');
      }),
    };
    const secondResult = {
      getAll: vi.fn(async () => {
        events.push('second:getAll');
        return [];
      }),
      close: vi.fn(() => {
        events.push('second:close');
      }),
    };
    const genericResult = {
      getAll: vi.fn(async () => []),
      close: vi.fn(),
    };
    const conn = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'MATCH (n:File) RETURN n.id AS id') {
          events.push('stream:query');
          return [firstResult, secondResult];
        }
        return genericResult;
      }),
      close: vi.fn(async () => {}),
    };
    const db = {
      close: vi.fn(async () => {}),
    };

    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: vi.fn(async () => ({ db, conn })),
      closeLbugConnection: vi.fn(async () => {}),
      isDbBusyError: vi.fn((err: unknown) => String(err).toLowerCase().includes('lock')),
      isOpenRetryExhausted: vi.fn(() => false),
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: vi.fn(async () => true),
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug('/tmp/gitnexus-lbug-stream-lifecycle/lbug');

    const rows: unknown[] = [];
    events.length = 0;
    await expect(
      adapter.streamQuery('MATCH (n:File) RETURN n.id AS id', (row) => {
        rows.push(row);
      }),
    ).resolves.toBe(1);

    expect(rows).toEqual([{ id: 'file:a' }]);
    expect(events).toEqual([
      'stream:query',
      'first:hasNext:true',
      'first:getNext',
      'first:hasNext:false',
      'first:getAll',
      'first:close',
      'second:getAll',
      'second:close',
    ]);

    await adapter.closeLbug();
  });

  it('drains stream query results when row handling fails before the result is exhausted', async () => {
    vi.resetModules();

    const events: string[] = [];
    const queryResult = {
      hasNext: vi.fn(() => {
        events.push('stream:hasNext');
        return true;
      }),
      getNext: vi.fn(async () => {
        events.push('stream:getNext');
        return { id: 'file:a' };
      }),
      getAll: vi.fn(async () => {
        events.push('stream:getAll');
        return [{ id: 'file:b' }];
      }),
      close: vi.fn(() => {
        events.push('stream:close');
      }),
    };
    const genericResult = {
      getAll: vi.fn(async () => []),
      close: vi.fn(),
    };
    const conn = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'MATCH (n:File) RETURN n.id AS id') {
          events.push('stream:query');
          return queryResult;
        }
        return genericResult;
      }),
      close: vi.fn(async () => {}),
    };
    const db = {
      close: vi.fn(async () => {}),
    };

    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: vi.fn(async () => ({ db, conn })),
      closeLbugConnection: vi.fn(async () => {}),
      isDbBusyError: vi.fn((err: unknown) => String(err).toLowerCase().includes('lock')),
      isOpenRetryExhausted: vi.fn(() => false),
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: vi.fn(async () => true),
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug('/tmp/gitnexus-lbug-stream-error-lifecycle/lbug');

    await expect(
      adapter.streamQuery('MATCH (n:File) RETURN n.id AS id', () => {
        throw new Error('client disconnected');
      }),
    ).rejects.toThrow('client disconnected');

    expect(events).toEqual([
      'stream:query',
      'stream:hasNext',
      'stream:getNext',
      'stream:getAll',
      'stream:close',
    ]);

    await adapter.closeLbug();
  });
});
