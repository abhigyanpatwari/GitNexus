/**
 * U13 (partial) — Isolated tests for the extracted quarantine layer.
 *
 * Worker-pool resilience integration tests (`worker-pool-resilience`,
 * `worker-pool-windows-quarantine`, `worker-pool.test.ts`) already
 * exercise the quarantine through the full pool. This file pins the
 * module's interface CONTRACT directly so a future change to the
 * quarantine surface — extra methods, signature drift, snapshot
 * shape — surfaces a focused failure here instead of cascading into
 * the larger integration suite.
 *
 * Notably: the `snapshot()` return type is `string[]`, not `Set` or
 * iterator. Tests pin that callers can both mutate the returned array
 * (it's a defensive copy) AND pass it directly to consumers expecting
 * `string[]` (the `WorkerPoolDispatchError` fallback-exclude-paths
 * shape).
 */
import { describe, it, expect } from 'vitest';
import { createQuarantine } from '../../../src/core/ingestion/workers/quarantine.js';

describe('quarantine module (U13 partial)', () => {
  it('starts empty', () => {
    const q = createQuarantine();
    expect(q.size).toBe(0);
    expect(q.snapshot()).toEqual([]);
    expect(q.has('any/path.ts')).toBe(false);
  });

  it('records exact-string paths via add() and reports them via has() + size', () => {
    const q = createQuarantine();
    q.add('src/bad.ts');
    expect(q.size).toBe(1);
    expect(q.has('src/bad.ts')).toBe(true);
    expect(q.has('src/other.ts')).toBe(false);
  });

  it('deduplicates repeated add() calls — size grows by exactly one distinct path', () => {
    const q = createQuarantine();
    q.add('src/bad.ts');
    q.add('src/bad.ts');
    q.add('src/bad.ts');
    expect(q.size).toBe(1);
  });

  it('preserves separator-style for round-trip (no normalization — matches U9 / M5 contract)', () => {
    // Pins the contract worker-pool-windows-quarantine.test.ts asserts
    // at the pool level: the quarantine layer treats paths as opaque
    // strings. `src\\bad.ts` and `src/bad.ts` are distinct entries.
    const q = createQuarantine();
    q.add('src\\bad.ts');
    expect(q.has('src\\bad.ts')).toBe(true);
    expect(q.has('src/bad.ts')).toBe(false);
    expect(q.size).toBe(1);
  });

  it('snapshot() returns a defensive copy — mutation does not leak back into the quarantine', () => {
    const q = createQuarantine();
    q.add('src/a.ts');
    q.add('src/b.ts');
    const snap = q.snapshot();
    expect(snap.sort()).toEqual(['src/a.ts', 'src/b.ts']);

    // Mutate the returned array; the internal state must not change.
    snap.length = 0;
    snap.push('src/never-added.ts');
    expect(q.size).toBe(2);
    expect(q.has('src/a.ts')).toBe(true);
    expect(q.has('src/never-added.ts')).toBe(false);
  });

  it('snapshots are independent — successive calls return fresh arrays', () => {
    const q = createQuarantine();
    q.add('src/a.ts');
    const first = q.snapshot();
    const second = q.snapshot();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('reflects subsequent add() calls in later snapshots', () => {
    const q = createQuarantine();
    q.add('src/a.ts');
    expect(q.snapshot()).toEqual(['src/a.ts']);
    q.add('src/b.ts');
    expect(q.snapshot().sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('size is a getter, not a stale property — reflects state at access time', () => {
    const q = createQuarantine();
    expect(q.size).toBe(0);
    q.add('src/a.ts');
    expect(q.size).toBe(1);
    q.add('src/b.ts');
    expect(q.size).toBe(2);
  });
});
