import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connectionQueryMock, finalizeSpy } = vi.hoisted(() => ({
  connectionQueryMock: vi.fn(),
  finalizeSpy: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn().mockResolvedValue({ size: 0 }),
    readdir: vi.fn().mockResolvedValue([]),
    access: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(function (this: any) {
      this.close = vi.fn().mockResolvedValue(undefined);
      this.query = connectionQueryMock;
    }),
  },
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  loadFTSExtension: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/core/lbug/lbug-config.js', () => ({
  createLbugDatabase: vi.fn(),
  toNativeSafePath: vi.fn((p: string) => p),
  LBUG_MAX_DB_SIZE: 1024,
  WAL_RECOVERY_SUGGESTION: 'rebuild',
  isWalCorruptionError: vi.fn(() => false),
}));

vi.mock('../../src/mcp/stdio-capture.js', () => ({
  realStdoutWrite: vi.fn(),
  realStderrWrite: vi.fn(),
  setActiveStdoutWrite: vi.fn(),
  getActiveStdoutWrite: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/core/lbug/sidecar-recovery.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/lbug/sidecar-recovery.js')>();
  return {
    ...actual,
    finalizeLbugSidecarsAfterClose: finalizeSpy,
  };
});

import { createLbugDatabase } from '../../src/core/lbug/lbug-config.js';

function makeMockDb() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    _isClosed: false,
  } as any;
}

describe('pool close sidecar finalization', () => {
  beforeEach(() => {
    connectionQueryMock.mockReset();
    connectionQueryMock.mockResolvedValue({
      getAll: vi.fn().mockResolvedValue([]),
      close: vi.fn(),
    });
    finalizeSpy.mockReset();
    finalizeSpy.mockResolvedValue(undefined);
    (createLbugDatabase as any).mockReset();
  });

  afterEach(async () => {
    const poolAdapter = await import('../../src/core/lbug/pool-adapter.js');
    await poolAdapter.closeLbug().catch(() => {});
    vi.clearAllMocks();
  });

  it('runs post-close sidecar finalization for pooled databases', async () => {
    const dbPath = '/tmp/test-pool-close-finalize/lbug';
    const db = makeMockDb();
    (createLbugDatabase as any).mockReturnValue(db);

    const { initLbug, closeLbug } = await import('../../src/core/lbug/pool-adapter.js');

    await initLbug('repo-close-finalize', dbPath);
    await closeLbug('repo-close-finalize');

    expect(db.close).toHaveBeenCalled();
    expect(finalizeSpy).toHaveBeenCalledWith(dbPath, {
      logger: expect.objectContaining({
        warn: expect.any(Function),
        info: expect.any(Function),
        debug: expect.any(Function),
      }),
    });
  });

  it('waits for database close before post-close sidecar finalization', async () => {
    const dbPath = '/tmp/test-pool-close-finalize-order/lbug';
    const events: string[] = [];
    const db = makeMockDb();
    db.close = vi.fn(async () => {
      events.push('db.close:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('db.close:end');
    });
    finalizeSpy.mockImplementation(async () => {
      events.push('finalize');
    });
    (createLbugDatabase as any).mockReturnValue(db);

    const { initLbug, closeLbug } = await import('../../src/core/lbug/pool-adapter.js');

    await initLbug('repo-close-finalize-order', dbPath);
    await closeLbug('repo-close-finalize-order');

    expect(events).toEqual(['db.close:start', 'db.close:end', 'finalize']);
  });
});
