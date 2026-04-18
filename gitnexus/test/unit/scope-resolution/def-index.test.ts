/**
 * Unit tests for `buildDefIndex` / `DefIndex` (RFC #909 Ring 2 SHARED #913).
 *
 * Covers: build-from-list, O(1) lookup contract, first-write-wins on
 * duplicate `nodeId`, readonly surface.
 */

import { describe, it, expect } from 'vitest';
import { buildDefIndex, type SymbolDefinition } from 'gitnexus-shared';

const makeDef = (overrides: Partial<SymbolDefinition> = {}): SymbolDefinition => ({
  nodeId: 'def:test',
  filePath: 'src/test.ts',
  type: 'Method',
  ...overrides,
});

describe('buildDefIndex', () => {
  it('builds an empty index from an empty input', () => {
    const idx = buildDefIndex([]);
    expect(idx.size).toBe(0);
    expect(idx.get('anything')).toBeUndefined();
    expect(idx.has('anything')).toBe(false);
  });

  it('stores a single def and round-trips by nodeId', () => {
    const def = makeDef({ nodeId: 'def:User.save' });
    const idx = buildDefIndex([def]);
    expect(idx.size).toBe(1);
    expect(idx.has('def:User.save')).toBe(true);
    expect(idx.get('def:User.save')).toBe(def); // reference identity
  });

  it('stores multiple defs under their distinct ids', () => {
    const a = makeDef({ nodeId: 'def:A' });
    const b = makeDef({ nodeId: 'def:B' });
    const c = makeDef({ nodeId: 'def:C' });
    const idx = buildDefIndex([a, b, c]);
    expect(idx.size).toBe(3);
    expect(idx.get('def:A')).toBe(a);
    expect(idx.get('def:B')).toBe(b);
    expect(idx.get('def:C')).toBe(c);
  });

  it('first-write-wins on duplicate nodeId', () => {
    const first = makeDef({ nodeId: 'def:dup', returnType: 'Original' });
    const second = makeDef({ nodeId: 'def:dup', returnType: 'Shadow' });
    const idx = buildDefIndex([first, second]);
    expect(idx.size).toBe(1);
    expect(idx.get('def:dup')).toBe(first);
    expect(idx.get('def:dup')?.returnType).toBe('Original');
  });

  it("returns undefined for a missing id (doesn't throw)", () => {
    const idx = buildDefIndex([makeDef({ nodeId: 'def:A' })]);
    expect(idx.get('def:missing')).toBeUndefined();
    expect(idx.has('def:missing')).toBe(false);
  });

  it('exposes byId as the underlying read-only Map for direct iteration', () => {
    const a = makeDef({ nodeId: 'def:A' });
    const b = makeDef({ nodeId: 'def:B' });
    const idx = buildDefIndex([a, b]);
    const entries = Array.from(idx.byId.entries())
      .map(([id]) => id)
      .sort();
    expect(entries).toEqual(['def:A', 'def:B']);
  });
});
