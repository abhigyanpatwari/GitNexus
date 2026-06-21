/**
 * Unit tests for the LadybugDB connection serialization lock (conn-lock.ts).
 *
 * This lock is the fix for the `analyze --pdg` native crash: the WAL-checkpoint
 * driver's periodic CHECKPOINT was executing on the shared singleton connection
 * concurrently with a long-running COPY, and LadybugDB's single-writer
 * Connection corrupts native heap state under concurrent query execution
 * (`double free or corruption (out)` / SIGSEGV). These tests assert the
 * lock's one-at-a-time guarantee deterministically, with no native engine —
 * the property that makes the otherwise-crashing overlap safe.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { withConnLock, _resetConnLockForTests } from '../../src/core/lbug/conn-lock.js';

afterEach(() => {
  _resetConnLockForTests();
});

describe('withConnLock — connection serialization', () => {
  it('runs critical sections one at a time in FIFO order with no interleave', async () => {
    const events: string[] = [];
    const section = (id: string, yields: number) => async (): Promise<void> => {
      events.push(`${id}:enter`);
      // Yield to the microtask queue repeatedly. Without serialization a later
      // section's `enter` would slip in between these yields.
      for (let i = 0; i < yields; i++) await Promise.resolve();
      events.push(`${id}:exit`);
    };

    // B and C are launched while A (which yields the most) is mid-flight.
    await Promise.all([
      withConnLock(section('A', 5)),
      withConnLock(section('B', 0)),
      withConnLock(section('C', 0)),
    ]);

    expect(events).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit', 'C:enter', 'C:exit']);
  });

  it('never lets two critical sections overlap under heavy concurrency', async () => {
    let active = 0;
    const observedMax: number[] = [];
    const op = () => async (): Promise<void> => {
      active++;
      observedMax.push(active);
      await Promise.resolve();
      await Promise.resolve();
      active--;
    };

    await Promise.all(Array.from({ length: 25 }, () => withConnLock(op())));

    // The concurrency count observed at the top of every critical section was
    // always exactly 1 — i.e. no two ran at once. This is precisely what stops
    // the checkpoint driver from racing a COPY on the native connection.
    expect(Math.max(...observedMax)).toBe(1);
  });

  it('releases the lock when a critical section throws (no permanent wedge)', async () => {
    await expect(
      withConnLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // A failed op must not strand the lock — the next caller still acquires it.
    await expect(withConnLock(async () => 'recovered')).resolves.toBe('recovered');
  });

  it('returns the wrapped operation result', async () => {
    await expect(withConnLock(async () => 42)).resolves.toBe(42);
  });
});

describe('withConnLock — re-entry guard', () => {
  it('throws on a nested (wrapped-in-wrapped) call instead of deadlocking', async () => {
    await expect(withConnLock(async () => withConnLock(async () => 'inner'))).rejects.toThrow(
      /re-entry/,
    );
  });

  it('does NOT false-fire on sequential (non-nested) calls', async () => {
    // Mirrors getLbugStats: many withConnLock calls in a loop, each awaited to
    // completion before the next — distinct async contexts, never nested.
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await withConnLock(async () => i));
    }
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('does NOT false-fire on concurrent top-level (queued) callers', async () => {
    // Legitimate contention: B and C call while A holds the lock. They are
    // separate async contexts (not nested in A's fn), so they queue, not throw.
    const out = await Promise.all([
      withConnLock(async () => 'a'),
      withConnLock(async () => 'b'),
      withConnLock(async () => 'c'),
    ]);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('releases the lock after a re-entry throw so later callers proceed', async () => {
    await expect(withConnLock(async () => withConnLock(async () => 'inner'))).rejects.toThrow(
      /re-entry/,
    );
    await expect(withConnLock(async () => 'ok')).resolves.toBe('ok');
  });
});
