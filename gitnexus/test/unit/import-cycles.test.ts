import { describe, expect, it } from 'vitest';
import { findImportCycles } from '../../src/core/graph/import-cycles.js';

describe('findImportCycles', () => {
  it('returns no cycles for an acyclic graph', () => {
    expect(
      findImportCycles([
        { source: 'src/a.ts', target: 'src/b.ts' },
        { source: 'src/b.ts', target: 'src/c.ts' },
      ]),
    ).toEqual([]);
  });

  it('returns deterministic concrete paths for cyclic components', () => {
    expect(
      findImportCycles([
        { source: 'src/b.ts', target: 'src/a.ts' },
        { source: 'src/a.ts', target: 'src/b.ts' },
        { source: 'src/y.ts', target: 'src/z.ts' },
        { source: 'src/z.ts', target: 'src/y.ts' },
      ]),
    ).toEqual([
      ['src/a.ts', 'src/b.ts', 'src/a.ts'],
      ['src/y.ts', 'src/z.ts', 'src/y.ts'],
    ]);
  });

  it('deduplicates edges and reports self-imports', () => {
    expect(
      findImportCycles([
        { source: 'src/a.ts', target: 'src/a.ts' },
        { source: 'src/a.ts', target: 'src/a.ts' },
      ]),
    ).toEqual([['src/a.ts', 'src/a.ts']]);
  });

  it('returns the shortest deterministic path through the component root', () => {
    expect(
      findImportCycles([
        { source: 'src/a.ts', target: 'src/b.ts' },
        { source: 'src/b.ts', target: 'src/c.ts' },
        { source: 'src/c.ts', target: 'src/d.ts' },
        { source: 'src/d.ts', target: 'src/a.ts' },
        { source: 'src/a.ts', target: 'src/z.ts' },
        { source: 'src/z.ts', target: 'src/a.ts' },
      ]),
    ).toEqual([['src/a.ts', 'src/z.ts', 'src/a.ts']]);
  });

  it('finds an edge-connected path when component sort order is not a path', () => {
    expect(
      findImportCycles([
        { source: 'src/a.ts', target: 'src/c.ts' },
        { source: 'src/c.ts', target: 'src/b.ts' },
        { source: 'src/b.ts', target: 'src/a.ts' },
      ]),
    ).toEqual([['src/a.ts', 'src/c.ts', 'src/b.ts', 'src/a.ts']]);
  });

  it('handles deep import graphs without recursive traversal', () => {
    const size = 20_000;
    const edges = Array.from({ length: size - 1 }, (_, index) => ({
      source: `src/${index}.ts`,
      target: `src/${index + 1}.ts`,
    }));
    expect(findImportCycles(edges)).toEqual([]);
  });
});
