/**
 * Unit tests for `expandTransitiveIncludeClosure` — the C/C++ Strategy 1
 * (`wildcard-transitive`) implementation extracted from `wildcard-synthesis.ts`.
 *
 * These tests exercise the BFS/DFS closure algorithm in isolation, without
 * running the full pipeline. They cover edge cases flagged in PR #816 review:
 * circular header includes, deep chains, and graphImports-only transitive paths.
 */

import { describe, it, expect } from 'vitest';
import { expandTransitiveIncludeClosure } from '../../src/core/ingestion/pipeline-phases/wildcard-synthesis.js';

const EMPTY = new Map<string, ReadonlySet<string>>();

describe('expandTransitiveIncludeClosure', () => {
  it('returns the direct imports when none are chained', () => {
    const direct = new Set(['a.h', 'b.h']);
    const closure = expandTransitiveIncludeClosure(direct, EMPTY, EMPTY);
    expect([...closure].sort()).toEqual(['a.h', 'b.h']);
  });

  it('expands a two-hop chain via importMap (a.c → b.h → c.h)', () => {
    const importMap = new Map<string, ReadonlySet<string>>([['b.h', new Set(['c.h'])]]);
    const closure = expandTransitiveIncludeClosure(new Set(['b.h']), importMap, EMPTY);
    expect([...closure].sort()).toEqual(['b.h', 'c.h']);
  });

  it('expands a deep 5-level chain (A → B → C → D → E)', () => {
    const importMap = new Map<string, ReadonlySet<string>>([
      ['B.h', new Set(['C.h'])],
      ['C.h', new Set(['D.h'])],
      ['D.h', new Set(['E.h'])],
    ]);
    const closure = expandTransitiveIncludeClosure(new Set(['B.h']), importMap, EMPTY);
    expect([...closure].sort()).toEqual(['B.h', 'C.h', 'D.h', 'E.h']);
  });

  it('terminates on circular header includes (A.h ↔ B.h)', () => {
    const importMap = new Map<string, ReadonlySet<string>>([
      ['A.h', new Set(['B.h'])],
      ['B.h', new Set(['A.h'])],
    ]);
    const closure = expandTransitiveIncludeClosure(new Set(['A.h']), importMap, EMPTY);
    expect([...closure].sort()).toEqual(['A.h', 'B.h']);
  });

  it('terminates on self-referential include (A.h includes A.h)', () => {
    const importMap = new Map<string, ReadonlySet<string>>([['A.h', new Set(['A.h'])]]);
    const closure = expandTransitiveIncludeClosure(new Set(['A.h']), importMap, EMPTY);
    expect([...closure]).toEqual(['A.h']);
  });

  it('expands through graphImports edges when importMap is empty', () => {
    const graphImports = new Map<string, ReadonlySet<string>>([['b.h', new Set(['c.h'])]]);
    const closure = expandTransitiveIncludeClosure(new Set(['b.h']), EMPTY, graphImports);
    expect([...closure].sort()).toEqual(['b.h', 'c.h']);
  });

  it('combines importMap and graphImports in one traversal', () => {
    const importMap = new Map<string, ReadonlySet<string>>([['b.h', new Set(['c.h'])]]);
    const graphImports = new Map<string, ReadonlySet<string>>([['c.h', new Set(['d.h'])]]);
    const closure = expandTransitiveIncludeClosure(new Set(['b.h']), importMap, graphImports);
    expect([...closure].sort()).toEqual(['b.h', 'c.h', 'd.h']);
  });

  it('returns an empty set when given no direct imports', () => {
    const closure = expandTransitiveIncludeClosure(new Set<string>(), EMPTY, EMPTY);
    expect(closure.size).toBe(0);
  });

  it('caps closure size to prevent OOM on pathological codebases', () => {
    // Build a synthetic include graph of 10,000 files, each including the next.
    // The cap (5000) should halt BFS early with a partial but bounded closure.
    const importMap = new Map<string, ReadonlySet<string>>();
    for (let i = 0; i < 10_000; i++) {
      importMap.set(`h${i}.h`, new Set([`h${i + 1}.h`]));
    }
    const closure = expandTransitiveIncludeClosure(new Set(['h0.h']), importMap, EMPTY);
    expect(closure.size).toBe(5000);
    // Partial closure still starts from the importer's side (BFS ordering).
    expect(closure.has('h0.h')).toBe(true);
    expect(closure.has('h1.h')).toBe(true);
    expect(closure.has('h9999.h')).toBe(false);
  });

  it('deduplicates when a file is reachable through multiple paths (diamond)', () => {
    //   A
    //  / \
    // B   C
    //  \ /
    //   D
    const importMap = new Map<string, ReadonlySet<string>>([
      ['A.h', new Set(['B.h', 'C.h'])],
      ['B.h', new Set(['D.h'])],
      ['C.h', new Set(['D.h'])],
    ]);
    const closure = expandTransitiveIncludeClosure(new Set(['A.h']), importMap, EMPTY);
    expect([...closure].sort()).toEqual(['A.h', 'B.h', 'C.h', 'D.h']);
    expect(closure.size).toBe(4); // D.h appears once
  });
});
