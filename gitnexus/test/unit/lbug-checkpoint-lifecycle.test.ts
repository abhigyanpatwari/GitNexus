import { afterEach, describe, expect, it, vi } from 'vitest';

const makeErrnoError = <TCode extends string>(code: TCode, message: string) =>
  Object.assign(new Error(message), { code });

/** Stub file handle returned by mocked `fs.open` for the init lock. */
const makeOpenMock = () =>
  vi.fn(async () => ({
    writeFile: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }));

/** Standard `fs/promises` mock for tests that only need doInitLbug to succeed. */
const mockFsForInit = (dbPath: string) => {
  const ENOENT_ERROR = makeErrnoError(
    'ENOENT',
    `ENOENT: no such file or directory, lstat '${dbPath}'`,
  );
  vi.doMock('fs/promises', () => ({
    default: {
      lstat: vi.fn(async () => {
        throw ENOENT_ERROR;
      }),
      access: vi.fn(async () => {
        throw ENOENT_ERROR;
      }),
      unlink: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      open: makeOpenMock(),
    },
  }));
};

describe('lbug adapter CHECKPOINT lifecycle', () => {
  afterEach(() => {
    vi.doUnmock('fs/promises');
    vi.doUnmock('../../src/core/lbug/lbug-config.js');
    vi.doUnmock('../../src/core/lbug/extension-loader.js');
    vi.doUnmock('../../src/core/logger.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('removes orphan sidecars when main DB file is missing before opening LadybugDB', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-orphan-sidecar/lbug';
    const ENOENT_ERROR = makeErrnoError(
      'ENOENT',
      `ENOENT: no such file or directory, access '${dbPath}'`,
    );
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    const conn = {
      query: vi.fn(async () => queryResult),
      close: vi.fn(async () => {}),
    };
    const db = { close: vi.fn(async () => {}) };

    const unlinkMock = vi.fn(async () => {});
    const accessMock = vi.fn(async () => {
      throw ENOENT_ERROR;
    });

    vi.doMock('fs/promises', () => ({
      default: {
        lstat: vi.fn(async () => {
          throw ENOENT_ERROR;
        }),
        access: accessMock,
        unlink: unlinkMock,
        mkdir: vi.fn(async () => {}),
        open: makeOpenMock(),
      },
    }));
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
    const warnMock = vi.fn();
    vi.doMock('../../src/core/logger.js', () => ({
      logger: {
        warn: warnMock,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(dbPath);

    expect(accessMock).toHaveBeenCalledWith(dbPath);
    // Unlink called for: .shadow sidecar, .wal.checkpoint sidecar, init lock release
    expect(unlinkMock).toHaveBeenCalledWith(`${dbPath}.shadow`);
    expect(unlinkMock).toHaveBeenCalledWith(`${dbPath}.wal.checkpoint`);
    expect(unlinkMock).toHaveBeenCalledWith(`${dbPath}.init.lock`);
    expect(warnMock).toHaveBeenCalledTimes(2);
    expect(warnMock).toHaveBeenCalledWith(
      'GitNexus: removed orphan sidecar lbug.shadow (no main DB file present)',
    );
    expect(warnMock).toHaveBeenCalledWith(
      'GitNexus: removed orphan sidecar lbug.wal.checkpoint (no main DB file present)',
    );

    await adapter.closeLbug();
  });

  it('skips orphan sidecar cleanup when db access fails with non-ENOENT errors', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-orphan-sidecar-eacces/lbug';
    const ENOENT_ERROR = makeErrnoError(
      'ENOENT',
      `ENOENT: no such file or directory, access '${dbPath}'`,
    );
    const EACCES_ERROR = makeErrnoError('EACCES', `EACCES: permission denied, access '${dbPath}'`);
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    const conn = {
      query: vi.fn(async () => queryResult),
      close: vi.fn(async () => {}),
    };
    const db = { close: vi.fn(async () => {}) };
    const accessMock = vi.fn(async () => {
      throw EACCES_ERROR;
    });
    const unlinkMock = vi.fn(async () => {});

    vi.doMock('fs/promises', () => ({
      default: {
        lstat: vi.fn(async () => {
          throw ENOENT_ERROR;
        }),
        access: accessMock,
        unlink: unlinkMock,
        mkdir: vi.fn(async () => {}),
        open: makeOpenMock(),
      },
    }));
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
    const warnMock = vi.fn();
    vi.doMock('../../src/core/logger.js', () => ({
      logger: {
        warn: warnMock,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(dbPath);

    expect(accessMock).toHaveBeenCalledWith(dbPath);
    // Only the init lock release calls unlink — sidecar cleanup was skipped
    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledWith(`${dbPath}.init.lock`);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]?.[0]).toContain(
      'GitNexus: unable to verify main DB file before orphan sidecar cleanup (EACCES); skipping cleanup:',
    );

    await adapter.closeLbug();
  });

  it('does not remove sidecars when main db file is present', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-present/lbug';
    const ENOENT_ERROR = makeErrnoError(
      'ENOENT',
      `ENOENT: no such file or directory, access '${dbPath}'`,
    );
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    const conn = {
      query: vi.fn(async () => queryResult),
      close: vi.fn(async () => {}),
    };
    const db = { close: vi.fn(async () => {}) };
    const accessMock = vi.fn(async () => {});
    const unlinkMock = vi.fn(async () => {});

    vi.doMock('fs/promises', () => ({
      default: {
        lstat: vi.fn(async () => {
          throw ENOENT_ERROR;
        }),
        access: accessMock,
        unlink: unlinkMock,
        mkdir: vi.fn(async () => {}),
        open: makeOpenMock(),
      },
    }));
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
    const warnMock = vi.fn();
    vi.doMock('../../src/core/logger.js', () => ({
      logger: {
        warn: warnMock,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(dbPath);

    expect(accessMock).toHaveBeenCalledWith(dbPath);
    // Only the init lock release calls unlink — no sidecar cleanup needed
    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledWith(`${dbPath}.init.lock`);
    expect(warnMock).not.toHaveBeenCalled();

    await adapter.closeLbug();
  });

  it.each([
    {
      code: 'EPERM',
      message: 'operation not permitted',
      dbPath: '/tmp/gitnexus-lbug-lstat-eperm/lbug',
    },
    {
      code: 'EACCES',
      message: 'permission denied',
      dbPath: '/tmp/gitnexus-lbug-lstat-eacces/lbug',
    },
  ])('throws when db path lstat fails with non-ENOENT %s', async ({ code, message, dbPath }) => {
    vi.resetModules();

    const LSTAT_ERROR = makeErrnoError(code, `${code}: ${message}, lstat '${dbPath}'`);
    const accessMock = vi.fn(async () => {});
    const unlinkMock = vi.fn(async () => {});

    vi.doMock('fs/promises', () => ({
      default: {
        lstat: vi.fn(async () => {
          throw LSTAT_ERROR;
        }),
        access: accessMock,
        unlink: unlinkMock,
        mkdir: vi.fn(async () => {}),
        open: makeOpenMock(),
      },
    }));
    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: vi.fn(async () => {
        throw new Error('should not be called');
      }),
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
    vi.doMock('../../src/core/logger.js', () => ({
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await expect(adapter.initLbug(dbPath)).rejects.toThrow(new RegExp(message, 'i'));
    expect(accessMock).not.toHaveBeenCalled();
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('handles partial orphan sidecar state and removes only present sidecars', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-partial-sidecar/lbug';
    const ENOENT_ERROR = makeErrnoError(
      'ENOENT',
      `ENOENT: no such file or directory, access '${dbPath}'`,
    );
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    const conn = {
      query: vi.fn(async () => queryResult),
      close: vi.fn(async () => {}),
    };
    const db = { close: vi.fn(async () => {}) };
    const accessMock = vi.fn(async () => {
      throw ENOENT_ERROR;
    });
    const unlinkMock = vi.fn(async (target: string) => {
      if (target.endsWith('.shadow')) throw ENOENT_ERROR;
    });

    vi.doMock('fs/promises', () => ({
      default: {
        lstat: vi.fn(async () => {
          throw ENOENT_ERROR;
        }),
        access: accessMock,
        unlink: unlinkMock,
        mkdir: vi.fn(async () => {}),
        open: makeOpenMock(),
      },
    }));
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
    const warnMock = vi.fn();
    vi.doMock('../../src/core/logger.js', () => ({
      logger: {
        warn: warnMock,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(dbPath);

    expect(unlinkMock).toHaveBeenCalledWith(`${dbPath}.shadow`);
    expect(unlinkMock).toHaveBeenCalledWith(`${dbPath}.wal.checkpoint`);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      'GitNexus: removed orphan sidecar lbug.wal.checkpoint (no main DB file present)',
    );

    await adapter.closeLbug();
  });

  it('proceeds to openLbugConnection when orphan sidecar unlink fails', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-sidecar-unlink-fail/lbug';
    const ENOENT_ERROR = makeErrnoError(
      'ENOENT',
      `ENOENT: no such file or directory, access '${dbPath}'`,
    );
    const EPERM_ERROR = makeErrnoError(
      'EPERM',
      `EPERM: operation not permitted, unlink '${dbPath}.shadow'`,
    );
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    const conn = {
      query: vi.fn(async () => queryResult),
      close: vi.fn(async () => {}),
    };
    const db = { close: vi.fn(async () => {}) };
    const accessMock = vi.fn(async () => {
      throw ENOENT_ERROR;
    });
    const unlinkMock = vi.fn(async () => {
      throw EPERM_ERROR;
    });

    vi.doMock('fs/promises', () => ({
      default: {
        lstat: vi.fn(async () => {
          throw ENOENT_ERROR;
        }),
        access: accessMock,
        unlink: unlinkMock,
        mkdir: vi.fn(async () => {}),
        open: makeOpenMock(),
      },
    }));
    const openLbugConnectionMock = vi.fn(async () => ({ db, conn }));
    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: openLbugConnectionMock,
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
    const warnMock = vi.fn();
    vi.doMock('../../src/core/logger.js', () => ({
      logger: {
        warn: warnMock,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(dbPath);

    expect(unlinkMock).toHaveBeenCalledTimes(3);
    expect(warnMock).toHaveBeenCalledTimes(3);
    expect(warnMock.mock.calls[0]?.[0]).toContain(
      'GitNexus: failed to remove orphan sidecar lbug.shadow (EPERM) while main DB file is missing; LadybugDB open may still fail:',
    );
    expect(warnMock.mock.calls[1]?.[0]).toContain(
      'GitNexus: failed to remove orphan sidecar lbug.wal.checkpoint (EPERM) while main DB file is missing; LadybugDB open may still fail:',
    );
    expect(warnMock.mock.calls[2]?.[0]).toContain('GitNexus: failed to release init lock (EPERM)');
    expect(openLbugConnectionMock).toHaveBeenCalledWith(expect.anything(), dbPath);

    await adapter.closeLbug();
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

    mockFsForInit('/tmp/gitnexus-lbug-checkpoint-lifecycle/lbug');
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

    mockFsForInit('/tmp/gitnexus-lbug-query-lifecycle/lbug');
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

    mockFsForInit('/tmp/gitnexus-lbug-sync-close-lifecycle/lbug');
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

    mockFsForInit('/tmp/gitnexus-lbug-array-error-lifecycle/lbug');
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

    mockFsForInit('/tmp/gitnexus-lbug-stream-lifecycle/lbug');
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

    mockFsForInit('/tmp/gitnexus-lbug-stream-error-lifecycle/lbug');
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
