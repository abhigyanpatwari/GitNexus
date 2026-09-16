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
import { stalenessPayload, type IndexedRef } from '../../src/core/staleness-status.js';
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

describe('attachToolStaleness — status (#3256)', () => {
  it('labels a counted gap as behind', () => {
    const out = attachToolStaleness({ ok: true }, STALE) as { staleness: unknown };
    expect(out.staleness).toEqual({ status: 'behind', commitsBehind: 3, hint: STALE.hint });
  });

  it('attaches diverged with its hint and no invented count', () => {
    const out = attachToolStaleness(
      { ok: true },
      { isStale: false, commitsBehind: 0, status: 'diverged', hint: 'HEAD moved on' },
    ) as { staleness: Record<string, unknown> };
    expect(out.staleness).toEqual({ status: 'diverged', hint: 'HEAD moved on' });
    expect('commitsBehind' in out.staleness).toBe(false);
  });

  it('does not attach unknown to a hot read tool result', () => {
    // A `--skip-git` folder has no history to measure; repeating that on every
    // read tool response is noise, so `unknown` stays off this path.
    const result = { ok: true };
    expect(
      attachToolStaleness(result, { isStale: false, commitsBehind: 0, status: 'unknown' }),
    ).toBe(result);
  });

  it('still leaves a current index untouched', () => {
    const result = { ok: true };
    expect(
      attachToolStaleness(result, { isStale: false, commitsBehind: 0, status: 'current' }),
    ).toBe(result);
  });
});

// ── #3291: the ref-carrying form ─────────────────────────────────────────────
//
// `stalenessPayload` is the single builder behind three surfaces, so the fix has
// to add a shape without disturbing the one already in use. These pin both
// halves: WITHOUT a ref the output is bit-identical to the pre-#3291 shape for
// every status — which is what keeps `list_repos` and the `serve` repo routes
// byte-stable and their exact-match tests passing unmodified — and WITH one it
// names the index it describes, including when that index is `current`.

const REF: IndexedRef = {
  branch: 'feature/x',
  lastCommit: 'f'.repeat(40),
  indexedAt: '2026-09-15T00:00:00Z',
};

const CURRENT: StalenessInfo = { isStale: false, commitsBehind: 0, status: 'current' };
const UNKNOWN: StalenessInfo = { isStale: false, commitsBehind: 0, status: 'unknown' };
const DIVERGED: StalenessInfo = {
  isStale: false,
  commitsBehind: 0,
  hint: 'moved on',
  status: 'diverged',
};
const BEHIND: StalenessInfo = {
  isStale: true,
  commitsBehind: 3,
  hint: '3 behind',
  status: 'behind',
};

describe('stalenessPayload without a ref — unchanged by #3291', () => {
  it('omits the payload entirely for a current index', () => {
    expect(stalenessPayload(CURRENT)).toBeUndefined();
  });

  it('omits unknown unless the caller asks, and emits it bare when it does', () => {
    expect(stalenessPayload(UNKNOWN)).toBeUndefined();
    expect(stalenessPayload(UNKNOWN, { includeUnknown: true })).toEqual({ status: 'unknown' });
  });

  it('reports diverged with its hint and no invented count', () => {
    expect(stalenessPayload(DIVERGED)).toEqual({ status: 'diverged', hint: 'moved on' });
  });

  it('reports behind with the counted gap', () => {
    expect(stalenessPayload(BEHIND)).toEqual({
      status: 'behind',
      commitsBehind: 3,
      hint: '3 behind',
    });
  });
});

describe('stalenessPayload with a ref (#3291)', () => {
  it('emits a current index instead of suppressing it, naming the ref', () => {
    // The regression #3291 reported: `current` alone cannot distinguish an index
    // of the default branch from one of a feature branch.
    expect(stalenessPayload(CURRENT, { ref: REF })).toEqual({
      status: 'current',
      branch: 'feature/x',
      lastCommit: REF.lastCommit,
      indexedAt: REF.indexedAt,
      measuredAgainst: 'HEAD',
    });
  });

  it('names the ref on unknown too — which index answered is knowable when its freshness is not', () => {
    expect(stalenessPayload(UNKNOWN, { ref: REF })).toEqual({
      status: 'unknown',
      branch: 'feature/x',
      lastCommit: REF.lastCommit,
      indexedAt: REF.indexedAt,
      measuredAgainst: 'HEAD',
    });
  });

  it('keeps diverged free of an invented count while carrying the ref', () => {
    const out = stalenessPayload(DIVERGED, { ref: REF });
    expect(out).toEqual({
      status: 'diverged',
      branch: 'feature/x',
      lastCommit: REF.lastCommit,
      indexedAt: REF.indexedAt,
      measuredAgainst: 'HEAD',
      hint: 'moved on',
    });
    expect('commitsBehind' in (out ?? {})).toBe(false);
  });

  it('carries the counted gap alongside the ref', () => {
    expect(stalenessPayload(BEHIND, { ref: REF })).toEqual({
      status: 'behind',
      branch: 'feature/x',
      lastCommit: REF.lastCommit,
      indexedAt: REF.indexedAt,
      measuredAgainst: 'HEAD',
      commitsBehind: 3,
      hint: '3 behind',
    });
  });

  it('omits branch for a detached HEAD or legacy index, keeping lastCommit as the identifier', () => {
    const { branch: _unlabelled, ...noBranch } = REF;
    expect(stalenessPayload(CURRENT, { ref: noBranch })).toEqual({
      status: 'current',
      lastCommit: REF.lastCommit,
      indexedAt: REF.indexedAt,
      measuredAgainst: 'HEAD',
    });
  });
});
