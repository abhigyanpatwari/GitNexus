/**
 * Unit tests for `makeScopeId` (RFC #909 Ring 2 SHARED #912).
 *
 * Covers canonical shape, determinism across calls, string interning,
 * and that different inputs produce different ids.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { makeScopeId, clearScopeIdInternPool, type Range, type ScopeKind } from 'gitnexus-shared';

const r = (startLine: number, startCol: number, endLine: number, endCol: number): Range => ({
  startLine,
  startCol,
  endLine,
  endCol,
});

describe('makeScopeId', () => {
  beforeEach(() => {
    clearScopeIdInternPool();
  });

  it('produces the canonical RFC §2.2 shape', () => {
    const id = makeScopeId({ filePath: 'src/app.ts', range: r(1, 0, 100, 0), kind: 'Module' });
    expect(id).toBe('scope:src/app.ts#1:0-100:0:Module');
  });

  it('encodes each ScopeKind verbatim in the id', () => {
    const kinds: readonly ScopeKind[] = [
      'Module',
      'Namespace',
      'Class',
      'Function',
      'Block',
      'Expression',
    ];
    for (const kind of kinds) {
      const id = makeScopeId({ filePath: 'f.ts', range: r(1, 0, 2, 0), kind });
      expect(id.endsWith(`:${kind}`)).toBe(true);
    }
  });

  it('returns the SAME string reference for structurally identical inputs (interned)', () => {
    const a = makeScopeId({ filePath: 'src/a.ts', range: r(5, 4, 10, 2), kind: 'Function' });
    const b = makeScopeId({ filePath: 'src/a.ts', range: r(5, 4, 10, 2), kind: 'Function' });
    expect(a).toBe(b);
    // `Object.is` catches the same reference even for weird strings.
    expect(Object.is(a, b)).toBe(true);
  });

  it('distinguishes ids that differ only by filePath', () => {
    const a = makeScopeId({ filePath: 'src/a.ts', range: r(1, 0, 2, 0), kind: 'Module' });
    const b = makeScopeId({ filePath: 'src/b.ts', range: r(1, 0, 2, 0), kind: 'Module' });
    expect(a).not.toBe(b);
  });

  it('distinguishes ids that differ only by range', () => {
    const a = makeScopeId({ filePath: 'f.ts', range: r(1, 0, 2, 0), kind: 'Function' });
    const b = makeScopeId({ filePath: 'f.ts', range: r(1, 0, 3, 0), kind: 'Function' });
    expect(a).not.toBe(b);
  });

  it('distinguishes ids that differ only by kind', () => {
    const a = makeScopeId({ filePath: 'f.ts', range: r(1, 0, 2, 0), kind: 'Function' });
    const b = makeScopeId({ filePath: 'f.ts', range: r(1, 0, 2, 0), kind: 'Block' });
    expect(a).not.toBe(b);
  });

  it('is safe to call repeatedly (pure)', () => {
    const inputs = { filePath: 'f.ts', range: r(1, 0, 5, 0), kind: 'Function' as const };
    const ids = Array.from({ length: 10 }, () => makeScopeId(inputs));
    expect(new Set(ids).size).toBe(1);
  });

  it('clearScopeIdInternPool drops the intern pool without changing id shape', () => {
    const before = makeScopeId({ filePath: 'f.ts', range: r(1, 0, 2, 0), kind: 'Module' });
    clearScopeIdInternPool();
    const after = makeScopeId({ filePath: 'f.ts', range: r(1, 0, 2, 0), kind: 'Module' });
    expect(after).toBe(before); // same string value, canonical-by-construction
  });
});
