/**
 * #2655: `query`/`context`/`impact`/`cypher` tool responses carry a non-blocking
 * `staleness` signal when the index is behind HEAD, mirroring `list_repos`.
 *
 * These tests cover `attachToolStaleness` — the shape contract that guarantees
 * the signal is only ever ADDED to an object result and never mutates an
 * existing result's shape (so the CLI's `Array.isArray`-based `--limit` on
 * raw-array cypher rows, and any consumer's shape assumptions, keep working).
 */
import { describe, it, expect } from 'vitest';
import type { StalenessInfo } from '../../src/core/git-staleness.js';
import { attachToolStaleness } from '../../src/mcp/local/local-backend.js';

const STALE: StalenessInfo = {
  isStale: true,
  commitsBehind: 3,
  hint: '⚠️ Index is 3 commits behind HEAD. Run analyze tool to update.',
};
const FRESH: StalenessInfo = { isStale: false, commitsBehind: 0 };

describe('attachToolStaleness (#2655)', () => {
  it('adds a list_repos-shaped staleness field to an object result when stale', () => {
    const out = attachToolStaleness({ processes: [], total: 0 }, STALE);
    expect(out).toMatchObject({
      processes: [],
      total: 0,
      staleness: { commitsBehind: 3, hint: STALE.hint },
    });
  });

  it('leaves the result untouched when the index is fresh', () => {
    const result = { processes: [], total: 0 };
    expect(attachToolStaleness(result, FRESH)).toBe(result);
  });

  it('never changes the shape of a raw-array result (CLI --limit relies on Array.isArray)', () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const out = attachToolStaleness(rows, STALE);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toBe(rows);
  });

  it('does not annotate an error envelope', () => {
    const err = { error: 'LadybugDB not ready. Index may be corrupted.' };
    expect(attachToolStaleness(err, STALE)).toBe(err);
  });

  it('is idempotent — a result that already has staleness is left as-is', () => {
    const already = { total: 1, staleness: { commitsBehind: 9, hint: 'x' } };
    expect(attachToolStaleness(already, STALE)).toBe(already);
  });

  it('leaves non-object results (null / primitives) unchanged', () => {
    expect(attachToolStaleness(null, STALE)).toBeNull();
    expect(attachToolStaleness('markdown text', STALE)).toBe('markdown text');
  });

  it('is null-safe — a missing staleness info never throws or mutates the result', () => {
    const result = { total: 0 };
    expect(attachToolStaleness(result, undefined)).toBe(result);
  });

  it('carries hint through as-is (may be undefined on a stale-without-hint info)', () => {
    const out = attachToolStaleness(
      { ok: true },
      {
        isStale: true,
        commitsBehind: 1,
      },
    ) as { staleness: { commitsBehind: number; hint?: string } };
    expect(out.staleness).toMatchObject({ commitsBehind: 1 });
  });
});
