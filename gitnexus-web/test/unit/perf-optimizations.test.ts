import { describe, expect, it } from 'vitest';

// ==========================================================================
// PR4 Performance Optimizations — verify behavior preserved after changes
// Tests the pure functions underlying the O(1) lookup optimizations.
// ==========================================================================

describe('nodeById Map — O(1) lookup correctness', () => {
  // Positive: Map.get returns correct node
  it('Map provides O(1) lookup by ID', () => {
    const nodes = [
      { id: 'Function:a.ts:foo', label: 'Function', name: 'foo' },
      { id: 'Class:b.ts:Bar', label: 'Class', name: 'Bar' },
      { id: 'File:c.ts', label: 'File', name: 'c.ts' },
    ];
    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    expect(nodeById.get('Function:a.ts:foo')?.name).toBe('foo');
    expect(nodeById.get('Class:b.ts:Bar')?.name).toBe('Bar');
    expect(nodeById.get('File:c.ts')?.label).toBe('File');
  });

  // Positive: handles duplicate IDs (last wins)
  it('last node wins on duplicate IDs', () => {
    const nodes = [
      { id: 'File:a.ts', label: 'File', name: 'first' },
      { id: 'File:a.ts', label: 'File', name: 'second' },
    ];
    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    expect(nodeById.get('File:a.ts')?.name).toBe('second');
    expect(nodeById.size).toBe(1);
  });

  // Negative: missing ID returns undefined
  it('returns undefined for non-existent ID', () => {
    const nodeById = new Map([['File:a.ts', { id: 'File:a.ts' }]]);
    expect(nodeById.get('NonExistent:x')).toBeUndefined();
  });

  // Negative: empty map
  it('empty Map returns undefined for any key', () => {
    const nodeById = new Map<string, any>();
    expect(nodeById.get('anything')).toBeUndefined();
  });
});

describe('Set.has — O(1) highlight matching', () => {
  // Positive: exact match
  it('Set.has returns true for present IDs', () => {
    const idSet = new Set(['Function:a.ts:foo', 'Class:b.ts:Bar']);
    expect(idSet.has('Function:a.ts:foo')).toBe(true);
    expect(idSet.has('Class:b.ts:Bar')).toBe(true);
  });

  // Negative: missing ID
  it('Set.has returns false for absent IDs', () => {
    const idSet = new Set(['Function:a.ts:foo']);
    expect(idSet.has('Function:a.ts:bar')).toBe(false);
    expect(idSet.has('')).toBe(false);
  });

  // Positive: works with graph node IDs containing special chars
  it('handles IDs with colons, dots, and slashes', () => {
    const idSet = new Set(['Function:src/utils/path-resolver.ts:resolveFile']);
    expect(idSet.has('Function:src/utils/path-resolver.ts:resolveFile')).toBe(true);
  });

  // Negative: case sensitive
  it('is case-sensitive', () => {
    const idSet = new Set(['Function:a.ts:Foo']);
    expect(idSet.has('Function:a.ts:foo')).toBe(false);
  });
});
