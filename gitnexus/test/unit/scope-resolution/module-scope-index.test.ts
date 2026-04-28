/**
 * Unit tests for `buildModuleScopeIndex` / `ModuleScopeIndex`
 * (RFC #909 Ring 2 SHARED #913).
 */

import { describe, it, expect } from 'vitest';
import { buildModuleScopeIndex, type ModuleScopeEntry, type ScopeId } from 'gitnexus-shared';

const entry = (filePath: string, moduleScopeId: ScopeId): ModuleScopeEntry => ({
  filePath,
  moduleScopeId,
});

describe('buildModuleScopeIndex', () => {
  it('builds an empty index from no entries', () => {
    const idx = buildModuleScopeIndex([]);
    expect(idx.size).toBe(0);
    expect(idx.get('src/app.ts')).toBeUndefined();
    expect(idx.has('src/app.ts')).toBe(false);
  });

  it('round-trips a single entry', () => {
    const idx = buildModuleScopeIndex([entry('src/app.ts', 'scope:src/app.ts#1:0-100:0:Module')]);
    expect(idx.size).toBe(1);
    expect(idx.has('src/app.ts')).toBe(true);
    expect(idx.get('src/app.ts')).toBe('scope:src/app.ts#1:0-100:0:Module');
  });

  it('stores distinct files under their own scopes', () => {
    const entries: ModuleScopeEntry[] = [
      entry('src/a.ts', 'scope:a'),
      entry('src/b.ts', 'scope:b'),
      entry('src/c.ts', 'scope:c'),
    ];
    const idx = buildModuleScopeIndex(entries);
    expect(idx.size).toBe(3);
    expect(idx.get('src/a.ts')).toBe('scope:a');
    expect(idx.get('src/b.ts')).toBe('scope:b');
    expect(idx.get('src/c.ts')).toBe('scope:c');
  });

  it('first-write-wins when the same filePath appears twice', () => {
    const idx = buildModuleScopeIndex([
      entry('src/app.ts', 'scope:first'),
      entry('src/app.ts', 'scope:second'),
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get('src/app.ts')).toBe('scope:first');
  });

  it('returns undefined for a missing filePath (no throw)', () => {
    const idx = buildModuleScopeIndex([entry('src/a.ts', 'scope:a')]);
    expect(idx.get('src/missing.ts')).toBeUndefined();
    expect(idx.has('src/missing.ts')).toBe(false);
  });

  it('exposes byFilePath as the underlying read-only Map', () => {
    const idx = buildModuleScopeIndex([entry('src/a.ts', 'scope:a'), entry('src/b.ts', 'scope:b')]);
    const paths = Array.from(idx.byFilePath.keys()).sort();
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
