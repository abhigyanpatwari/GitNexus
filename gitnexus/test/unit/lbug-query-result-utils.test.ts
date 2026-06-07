/**
 * Unit tests: closeQueryResults — the shared best-effort cursor-close helper
 * (#2068 follow-up). Guards the contract the two LadybugDB adapters rely on:
 * a single result OR an array of results are all closed, and a failing/absent
 * `close()` never throws and never skips the rest.
 */
import { describe, it, expect, vi } from 'vitest';
import { closeQueryResults } from '../../src/core/lbug/query-result-utils.js';

// Minimal QueryResult stand-in — only `close()` matters here.
function fakeResult(close: () => unknown = () => undefined) {
  return { close: vi.fn(close) } as unknown as import('@ladybugdb/core').QueryResult;
}

describe('closeQueryResults', () => {
  it('closes a single QueryResult exactly once', async () => {
    const r = fakeResult();
    await closeQueryResults(r);
    expect(r.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('closes EVERY element of an array (not just the first)', async () => {
    const rs = [fakeResult(), fakeResult(), fakeResult()];
    await closeQueryResults(rs);
    for (const r of rs) {
      expect(r.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps closing the rest when one close() rejects (best-effort, no throw)', async () => {
    const ok1 = fakeResult();
    const bad = fakeResult(() => {
      throw new Error('native close failed');
    });
    const ok2 = fakeResult(() => Promise.reject(new Error('async close failed')));
    const ok3 = fakeResult();
    await expect(closeQueryResults([ok1, bad, ok2, ok3])).resolves.toBeUndefined();
    expect(ok1.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(ok3.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on an empty array', async () => {
    await expect(closeQueryResults([])).resolves.toBeUndefined();
  });
});
