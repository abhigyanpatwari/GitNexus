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
});
