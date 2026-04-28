/**
 * Unit tests for `buildPositionIndex` / `PositionIndex`
 * (RFC #909 Ring 2 SHARED #912).
 *
 * Covers: empty input, single scope, nested scopes (innermost-wins),
 * positions before/after all scopes, boundary positions (inclusive ends),
 * multi-file isolation, and duplicate-scope-id dedup.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPositionIndex,
  type Range,
  type Scope,
  type ScopeId,
  type ScopeKind,
} from 'gitnexus-shared';

// ─── Test helpers ───────────────────────────────────────────────────────────

const r = (startLine: number, startCol: number, endLine: number, endCol: number): Range => ({
  startLine,
  startCol,
  endLine,
  endCol,
});

const mkScope = (
  id: ScopeId,
  filePath: string,
  kind: ScopeKind,
  range: Range,
  parent: ScopeId | null = null,
): Scope => ({
  id,
  parent,
  kind,
  range,
  filePath,
  bindings: new Map(),
  ownedDefs: [],
  imports: [],
  typeBindings: new Map(),
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildPositionIndex', () => {
  describe('empty / missing', () => {
    it('returns undefined for any query on an empty index', () => {
      const idx = buildPositionIndex([]);
      expect(idx.size).toBe(0);
      expect(idx.atPosition('src/any.ts', 1, 0)).toBeUndefined();
    });

    it('returns undefined for unindexed filePaths', () => {
      const idx = buildPositionIndex([mkScope('scope:m', 'a.ts', 'Module', r(1, 0, 10, 0))]);
      expect(idx.atPosition('b.ts', 5, 0)).toBeUndefined();
    });

    it('returns undefined for positions before any scope in the file', () => {
      const idx = buildPositionIndex([mkScope('scope:m', 'a.ts', 'Module', r(5, 0, 10, 0))]);
      expect(idx.atPosition('a.ts', 1, 0)).toBeUndefined();
      expect(idx.atPosition('a.ts', 4, 99)).toBeUndefined();
    });

    it('returns undefined for positions after all scopes in the file', () => {
      const idx = buildPositionIndex([mkScope('scope:m', 'a.ts', 'Module', r(1, 0, 10, 5))]);
      expect(idx.atPosition('a.ts', 11, 0)).toBeUndefined();
      expect(idx.atPosition('a.ts', 10, 6)).toBeUndefined();
    });
  });

  describe('single scope lookup', () => {
    it('returns the scope id for a point inside its range', () => {
      const idx = buildPositionIndex([mkScope('scope:m', 'a.ts', 'Module', r(1, 0, 10, 0))]);
      expect(idx.atPosition('a.ts', 5, 4)).toBe('scope:m');
    });

    it('includes the start boundary', () => {
      const idx = buildPositionIndex([mkScope('scope:m', 'a.ts', 'Module', r(5, 2, 10, 0))]);
      expect(idx.atPosition('a.ts', 5, 2)).toBe('scope:m');
      expect(idx.atPosition('a.ts', 5, 1)).toBeUndefined();
    });

    it('includes the end boundary', () => {
      const idx = buildPositionIndex([mkScope('scope:m', 'a.ts', 'Module', r(1, 0, 10, 5))]);
      expect(idx.atPosition('a.ts', 10, 5)).toBe('scope:m');
      expect(idx.atPosition('a.ts', 10, 6)).toBeUndefined();
    });
  });

  describe('innermost-containing wins', () => {
    it('picks the innermost of nested scopes', () => {
      // Module[1..100] ⊃ Class[5..80] ⊃ Function[10..60] ⊃ Block[20..50]
      const idx = buildPositionIndex([
        mkScope('scope:mod', 'a.ts', 'Module', r(1, 0, 100, 0)),
        mkScope('scope:cls', 'a.ts', 'Class', r(5, 0, 80, 0), 'scope:mod'),
        mkScope('scope:fn', 'a.ts', 'Function', r(10, 0, 60, 0), 'scope:cls'),
        mkScope('scope:blk', 'a.ts', 'Block', r(20, 0, 50, 0), 'scope:fn'),
      ]);
      expect(idx.atPosition('a.ts', 30, 0)).toBe('scope:blk'); // deepest
      expect(idx.atPosition('a.ts', 15, 0)).toBe('scope:fn'); // inside fn, outside blk
      expect(idx.atPosition('a.ts', 7, 0)).toBe('scope:cls'); // inside class body only
      expect(idx.atPosition('a.ts', 2, 0)).toBe('scope:mod'); // module top
    });

    it('innermost wins when two scopes start at the same position', () => {
      // Two scopes both start at line 5 col 0; outer ends at 50, inner at 20.
      const idx = buildPositionIndex([
        mkScope('scope:outer', 'a.ts', 'Module', r(5, 0, 50, 0)),
        mkScope('scope:inner', 'a.ts', 'Function', r(5, 0, 20, 0), 'scope:outer'),
      ]);
      expect(idx.atPosition('a.ts', 10, 0)).toBe('scope:inner'); // both contain; inner wins
      expect(idx.atPosition('a.ts', 30, 0)).toBe('scope:outer'); // only outer contains
    });

    it('innermost wins when scopes share an end position but differ in start', () => {
      const idx = buildPositionIndex([
        mkScope('scope:outer', 'a.ts', 'Module', r(1, 0, 50, 0)),
        mkScope('scope:inner', 'a.ts', 'Function', r(30, 0, 50, 0), 'scope:outer'),
      ]);
      expect(idx.atPosition('a.ts', 40, 0)).toBe('scope:inner');
      expect(idx.atPosition('a.ts', 20, 0)).toBe('scope:outer');
    });

    it('returns the sibling whose range contains the query, not the other', () => {
      // Two non-overlapping siblings under the same parent.
      const idx = buildPositionIndex([
        mkScope('scope:mod', 'a.ts', 'Module', r(1, 0, 100, 0)),
        mkScope('scope:a', 'a.ts', 'Function', r(5, 0, 20, 0), 'scope:mod'),
        mkScope('scope:b', 'a.ts', 'Function', r(25, 0, 40, 0), 'scope:mod'),
      ]);
      expect(idx.atPosition('a.ts', 10, 0)).toBe('scope:a');
      expect(idx.atPosition('a.ts', 30, 0)).toBe('scope:b');
      expect(idx.atPosition('a.ts', 22, 0)).toBe('scope:mod'); // gap between siblings
    });

    it('returns the right (later-start) sibling when two siblings share a boundary point', () => {
      // Legal touching-boundary scenario per ScopeTree's non-overlap rule:
      // [5:0..10:0] and [10:0..15:0] meet at (10, 0) but do not overlap
      // (rangesOverlap treats end == start as "touches, not overlaps").
      // A query AT the shared point is contained by BOTH siblings; the
      // innermost-wins comparator breaks the tie by start position ASC:
      // the right sibling (starts at 10:0) is scanned first during the
      // backward pass and wins. See `atPosition` JSDoc.
      const idx = buildPositionIndex([
        mkScope('scope:mod', 'a.ts', 'Module', r(1, 0, 100, 0)),
        mkScope('scope:left', 'a.ts', 'Block', r(5, 0, 10, 0), 'scope:mod'),
        mkScope('scope:right', 'a.ts', 'Block', r(10, 0, 15, 0), 'scope:mod'),
      ]);
      expect(idx.atPosition('a.ts', 10, 0)).toBe('scope:right'); // shared boundary
      expect(idx.atPosition('a.ts', 7, 0)).toBe('scope:left'); // inside left only
      expect(idx.atPosition('a.ts', 12, 0)).toBe('scope:right'); // inside right only
    });
  });

  describe('multi-file isolation', () => {
    it('indexes each filePath independently — no cross-file hits', () => {
      const idx = buildPositionIndex([
        mkScope('scope:a-mod', 'a.ts', 'Module', r(1, 0, 50, 0)),
        mkScope('scope:b-mod', 'b.ts', 'Module', r(1, 0, 50, 0)),
      ]);
      expect(idx.atPosition('a.ts', 10, 0)).toBe('scope:a-mod');
      expect(idx.atPosition('b.ts', 10, 0)).toBe('scope:b-mod');
    });

    it('counts all indexed scopes in `size`', () => {
      const idx = buildPositionIndex([
        mkScope('scope:a-mod', 'a.ts', 'Module', r(1, 0, 50, 0)),
        mkScope('scope:a-fn', 'a.ts', 'Function', r(10, 0, 20, 0), 'scope:a-mod'),
        mkScope('scope:b-mod', 'b.ts', 'Module', r(1, 0, 50, 0)),
      ]);
      expect(idx.size).toBe(3);
    });
  });

  describe('column handling on the same line', () => {
    it('handles a single-line scope across columns', () => {
      const idx = buildPositionIndex([
        mkScope('scope:expr', 'a.ts', 'Expression', r(5, 10, 5, 20)),
      ]);
      expect(idx.atPosition('a.ts', 5, 10)).toBe('scope:expr'); // start inclusive
      expect(idx.atPosition('a.ts', 5, 15)).toBe('scope:expr'); // middle
      expect(idx.atPosition('a.ts', 5, 20)).toBe('scope:expr'); // end inclusive
      expect(idx.atPosition('a.ts', 5, 9)).toBeUndefined();
      expect(idx.atPosition('a.ts', 5, 21)).toBeUndefined();
    });

    it('handles nested scopes on the same line', () => {
      const idx = buildPositionIndex([
        mkScope('scope:outer', 'a.ts', 'Expression', r(5, 0, 5, 30)),
        mkScope('scope:inner', 'a.ts', 'Expression', r(5, 10, 5, 20), 'scope:outer'),
      ]);
      expect(idx.atPosition('a.ts', 5, 15)).toBe('scope:inner');
      expect(idx.atPosition('a.ts', 5, 5)).toBe('scope:outer');
      expect(idx.atPosition('a.ts', 5, 25)).toBe('scope:outer');
    });
  });

  describe('robustness', () => {
    it('deduplicates scopes with the same id', () => {
      const s = mkScope('scope:dup', 'a.ts', 'Module', r(1, 0, 10, 0));
      const idx = buildPositionIndex([s, s, s]);
      expect(idx.size).toBe(1);
      expect(idx.atPosition('a.ts', 5, 0)).toBe('scope:dup');
    });
  });
});
