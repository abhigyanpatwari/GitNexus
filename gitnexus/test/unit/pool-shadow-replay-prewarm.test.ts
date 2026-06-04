import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  replayRecovered: false,
}));

vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn().mockResolvedValue({}),
    unlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(function (this: any) {
      const taintedAtBirth = !state.replayRecovered;
      this.close = vi.fn().mockResolvedValue(undefined);
      this.query = vi.fn().mockImplementation(async () => {
        state.replayRecovered = true;
        return {
          getAll: vi.fn().mockResolvedValue([]),
          close: vi.fn(),
        };
      });
      this.prepare = vi.fn().mockResolvedValue({
        isSuccess: () => true,
        getErrorMessage: vi.fn(),
      });
      this.execute = vi.fn().mockImplementation(async () => {
        if (taintedAtBirth) {
          throw new Error(
            "Runtime exception: Couldn't replay shadow pages under read-only mode. Please re-open the database with read-write mode to replay shadow pages.",
          );
        }
        return {
          getAll: vi.fn().mockResolvedValue([{ ok: 1 }]),
          close: vi.fn(),
        };
      });
    }),
  },
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  loadFTSExtension: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/core/lbug/lbug-config.js', () => ({
  createLbugDatabase: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    _isClosed: false,
  })),
  toNativeSafePath: vi.fn((p: string) => p),
  LBUG_MAX_DB_SIZE: 1024,
  WAL_RECOVERY_SUGGESTION:
    'WAL corruption detected. Run `gitnexus analyze --force` to rebuild the index.',
  isWalCorruptionError: vi.fn(() => false),
}));

vi.mock('../../src/mcp/stdio-capture.js', () => ({
  realStdoutWrite: vi.fn(),
  realStderrWrite: vi.fn(),
  setActiveStdoutWrite: vi.fn(),
  getActiveStdoutWrite: vi.fn(() => vi.fn()),
}));

const { closeLbug, executeQuery, initLbug } = await import('../../src/core/lbug/pool-adapter.js');

describe('pool prewarm waits until shadow-replay stabilization', () => {
  beforeEach(() => {
    state.replayRecovered = false;
  });

  afterEach(async () => {
    await closeLbug().catch(() => {});
    vi.clearAllMocks();
  });

  it('creates pooled connections only after the bootstrap replay probe has settled', async () => {
    await initLbug('repo', '/tmp/test-pool-shadow-replay-prewarm/lbug');

    await expect(executeQuery('repo', 'MATCH (n) RETURN n LIMIT 1')).resolves.toEqual([{ ok: 1 }]);
  });
});
