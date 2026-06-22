/**
 * Unit tests for the shared bounded checkpoint-then-exit cleanup (#2264) used by
 * the CLI SIGINT handler and the worker SIGTERM handler. The checkpoint + exit are
 * injected so the helper is testable without touching the real LadybugDB close or
 * the real process.exit.
 */
import { describe, it, expect, vi } from 'vitest';
import { boundedCheckpointBeforeExit } from '../../src/core/lbug/shutdown-helpers.js';

describe('boundedCheckpointBeforeExit (#2264)', () => {
  it('checkpoints, runs beforeExit, then exits with the given code (in order)', async () => {
    const order: string[] = [];
    const exit = vi.fn<(code: number) => void>((c) => {
      order.push(`exit:${c}`);
    });

    await boundedCheckpointBeforeExit({
      exitCode: 130,
      checkpoint: vi.fn(async () => {
        order.push('checkpoint');
      }),
      beforeExit: () => {
        order.push('beforeExit');
      },
      exit,
    });

    expect(exit).toHaveBeenCalledWith(130);
    expect(order).toEqual(['checkpoint', 'beforeExit', 'exit:130']);
  });

  it('reports a checkpoint failure via onFlushError and still exits', async () => {
    const onFlushError = vi.fn<(err: unknown) => void>();
    const exit = vi.fn<(code: number) => void>();
    const err = new Error('checkpoint boom');

    await boundedCheckpointBeforeExit({
      exitCode: 0,
      checkpoint: vi.fn(async () => {
        throw err;
      }),
      onFlushError,
      exit,
    });

    expect(onFlushError).toHaveBeenCalledWith(err);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits via the timeout when the checkpoint hangs', async () => {
    const exit = vi.fn<(code: number) => void>();

    await boundedCheckpointBeforeExit({
      exitCode: 0,
      timeoutMs: 0,
      checkpoint: () => new Promise<void>(() => {}), // never resolves
      exit,
    });

    expect(exit).toHaveBeenCalledWith(0);
  });
});
