import { describe, expect, it, vi } from 'vitest';

import { dispatchChunkParse } from '../gitnexus/src/core/ingestion/parsing-processor.js';
import {
  WorkerPoolInitializationError,
  type WorkerPool,
} from '../gitnexus/src/core/ingestion/workers/worker-pool.js';

const files = [{ path: 'src/retry.ts', content: 'export const retry = true;\n' }];

function startupFailure(crashClass: 'transient-exhausted' | 'deterministic-startup') {
  return new WorkerPoolInitializationError('hidden oracle worker failure', [], [], crashClass);
}

describe('hidden oracle: bounded parse-worker retry', () => {
  it('retries a transient dispatch twice and returns the recovered result', async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(startupFailure('transient-exhausted'))
      .mockRejectedValueOnce(startupFailure('transient-exhausted'))
      .mockResolvedValueOnce([]);
    const pool = { size: 1, dispatch, terminate: vi.fn() } as unknown as WorkerPool;

    await expect(dispatchChunkParse(files, pool)).resolves.toEqual([]);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('does not retry a deterministic parse-worker failure', async () => {
    const failure = startupFailure('deterministic-startup');
    const dispatch = vi.fn().mockRejectedValue(failure);
    const pool = { size: 1, dispatch, terminate: vi.fn() } as unknown as WorkerPool;

    await expect(dispatchChunkParse(files, pool)).rejects.toBe(failure);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
