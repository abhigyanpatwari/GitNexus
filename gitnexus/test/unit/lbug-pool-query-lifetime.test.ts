import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prepare, execute, begin, end } = vi.hoisted(() => ({
  prepare: vi.fn(),
  execute: vi.fn(),
  begin: vi.fn(() => ({})),
  end: vi.fn(),
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Connection: vi.fn(function (this: any) {
      this.prepare = prepare;
      this.execute = execute;
      this.close = vi.fn().mockResolvedValue(undefined);
    }),
  },
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  isReadOnlyDbError: () => false,
  loadFTSExtension: async () => false,
  loadVectorExtension: async () => false,
}));
vi.mock('../../src/core/lbug/query-memory-guard.js', () => ({
  queryMemoryGuard: { begin, end },
}));

import {
  closeLbug,
  executeParameterized,
  initLbugWithDb,
} from '../../src/core/lbug/pool-adapter.js';

describe('pooled query native lifetime', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    prepare.mockResolvedValue({ isSuccess: () => true });
    execute.mockResolvedValue({ getAll: async () => [{ n: 1 }], close: vi.fn() });
    await initLbugWithDb('query-lifetime', {} as any, '/tmp/query-lifetime-db');
  });

  afterEach(async () => {
    await closeLbug();
    vi.useRealTimers();
  });

  it.each(['prepare', 'execute', 'getAll'] as const)(
    'keeps monitoring after a caller times out in %s until native work settles',
    async (stage) => {
      let release!: (value: any) => void;
      const pending = new Promise<any>((resolve) => {
        release = resolve;
      });
      const close = vi.fn();
      const result = { getAll: async () => [{ n: 1 }], close };
      if (stage === 'prepare') prepare.mockReturnValueOnce(pending);
      else if (stage === 'execute') execute.mockReturnValueOnce(pending);
      else execute.mockResolvedValueOnce({ getAll: () => pending, close });

      const query = executeParameterized('query-lifetime', 'RETURN 1 AS n', {}).catch((e) => e);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(end).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      release(
        stage === 'prepare' ? { isSuccess: () => true } : stage === 'execute' ? result : [{ n: 1 }],
      );
      const error = await query;
      await vi.advanceTimersByTimeAsync(0);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('timed out');
      expect(end).toHaveBeenCalledTimes(1);
      if (stage !== 'prepare') expect(close).toHaveBeenCalledTimes(1);
      await expect(executeParameterized('query-lifetime', 'RETURN 1 AS n', {})).resolves.toEqual([
        { n: 1 },
      ]);
    },
  );

  it('releases monitoring and the connection after a native rejection', async () => {
    execute.mockRejectedValueOnce(new Error('native failure'));
    await expect(executeParameterized('query-lifetime', 'RETURN 1', {})).rejects.toThrow(
      'native failure',
    );
    expect(end).toHaveBeenCalledTimes(1);
    await expect(executeParameterized('query-lifetime', 'RETURN 1', {})).resolves.toEqual([
      { n: 1 },
    ]);
  });

  it('does not reuse timed-out connections while their native operations still run', async () => {
    let release!: (value: any) => void;
    const pending = new Promise<any>((resolve) => {
      release = resolve;
    });
    execute.mockReturnValue(pending);
    const first = Array.from({ length: 8 }, () =>
      executeParameterized('query-lifetime', 'RETURN 1', {}).catch((e) => e),
    );
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await Promise.all(first)).every((e) => e instanceof Error)).toBe(true);
    const waiting = executeParameterized('query-lifetime', 'RETURN 2', {});
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(8);
    expect(end).not.toHaveBeenCalled();
    execute.mockResolvedValue({ getAll: async () => [{ n: 2 }], close: vi.fn() });
    release({ getAll: async () => [{ n: 1 }], close: vi.fn() });
    await expect(waiting).resolves.toEqual([{ n: 2 }]);
    expect(end).toHaveBeenCalledTimes(9);
  });
});
