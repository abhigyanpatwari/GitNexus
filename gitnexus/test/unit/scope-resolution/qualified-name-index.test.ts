/**
 * Unit tests for `buildQualifiedNameIndex` / `QualifiedNameIndex`
 * (RFC #909 Ring 2 SHARED #913).
 *
 * Covers: per-kind accumulation, multi-def-per-qname (partial classes /
 * overloads), skipping defs without a qualifiedName, duplicate-pair dedup,
 * and empty-bucket iteration guarantee.
 */

import { describe, it, expect } from 'vitest';
import { buildQualifiedNameIndex, type SymbolDefinition } from 'gitnexus-shared';

const makeDef = (overrides: Partial<SymbolDefinition> = {}): SymbolDefinition => ({
  nodeId: 'def:test',
  filePath: 'src/test.ts',
  type: 'Class',
  ...overrides,
});

describe('buildQualifiedNameIndex', () => {
  it('builds an empty index from no defs', () => {
    const idx = buildQualifiedNameIndex([]);
    expect(idx.size).toBe(0);
    expect(idx.get('anything')).toEqual([]);
    expect(idx.has('anything')).toBe(false);
  });

  it('indexes a single qualified-named def', () => {
    const def = makeDef({ nodeId: 'def:app.User', qualifiedName: 'app.User' });
    const idx = buildQualifiedNameIndex([def]);
    expect(idx.size).toBe(1);
    expect(idx.has('app.User')).toBe(true);
    expect(idx.get('app.User')).toEqual(['def:app.User']);
  });

  it('accumulates distinct DefIds under the same qualified name (partial classes)', () => {
    // C# partial classes: same qname, different files/nodeIds
    const a = makeDef({
      nodeId: 'def:app.User:Core',
      qualifiedName: 'app.User',
      filePath: 'src/User.Core.cs',
    });
    const b = makeDef({
      nodeId: 'def:app.User:Api',
      qualifiedName: 'app.User',
      filePath: 'src/User.Api.cs',
    });
    const idx = buildQualifiedNameIndex([a, b]);
    expect(idx.get('app.User')).toEqual(['def:app.User:Core', 'def:app.User:Api']);
  });

  it('preserves input order in the bucket', () => {
    const a = makeDef({ nodeId: 'def:a', qualifiedName: 'app.Foo' });
    const b = makeDef({ nodeId: 'def:b', qualifiedName: 'app.Foo' });
    const c = makeDef({ nodeId: 'def:c', qualifiedName: 'app.Foo' });
    const idx = buildQualifiedNameIndex([c, a, b]);
    expect(idx.get('app.Foo')).toEqual(['def:c', 'def:a', 'def:b']);
  });

  it('separates defs that share a simple name but differ in qualifiedName', () => {
    const appUser = makeDef({ nodeId: 'def:app.User', qualifiedName: 'app.User' });
    const adminUser = makeDef({ nodeId: 'def:admin.User', qualifiedName: 'admin.User' });
    const idx = buildQualifiedNameIndex([appUser, adminUser]);
    expect(idx.get('app.User')).toEqual(['def:app.User']);
    expect(idx.get('admin.User')).toEqual(['def:admin.User']);
  });

  it('skips defs that have no qualifiedName', () => {
    const qnamed = makeDef({ nodeId: 'def:app.Foo', qualifiedName: 'app.Foo' });
    const anon = makeDef({ nodeId: 'def:anon', qualifiedName: undefined });
    const idx = buildQualifiedNameIndex([qnamed, anon]);
    expect(idx.size).toBe(1);
    expect(idx.get('app.Foo')).toEqual(['def:app.Foo']);
    expect(idx.has('')).toBe(false);
  });

  it('skips defs with an empty-string qualifiedName', () => {
    const empty = makeDef({ nodeId: 'def:empty', qualifiedName: '' });
    const idx = buildQualifiedNameIndex([empty]);
    expect(idx.size).toBe(0);
    expect(idx.has('')).toBe(false);
  });

  it('deduplicates exact (qname, DefId) pairs when the same def appears twice in input', () => {
    const def = makeDef({ nodeId: 'def:app.Foo', qualifiedName: 'app.Foo' });
    const idx = buildQualifiedNameIndex([def, def]);
    expect(idx.get('app.Foo')).toEqual(['def:app.Foo']); // not duplicated
  });

  it('indexes across heterogeneous kinds (Class + Method + Field may share qname convention)', () => {
    const klass = makeDef({
      nodeId: 'def:class:app.User',
      type: 'Class',
      qualifiedName: 'app.User',
    });
    const method = makeDef({
      nodeId: 'def:method:app.User.save',
      type: 'Method',
      qualifiedName: 'app.User.save',
    });
    const idx = buildQualifiedNameIndex([klass, method]);
    expect(idx.size).toBe(2);
    expect(idx.get('app.User')).toEqual(['def:class:app.User']);
    expect(idx.get('app.User.save')).toEqual(['def:method:app.User.save']);
  });

  it('returns a frozen empty array (not undefined) for misses so callers can iterate safely', () => {
    const idx = buildQualifiedNameIndex([makeDef({ qualifiedName: 'app.Foo' })]);
    const miss = idx.get('app.Missing');
    expect(miss).toEqual([]);
    expect(() => (miss as unknown as string[]).push('x')).toThrow();
  });

  it('exposes byQualifiedName as a read-only Map for direct iteration', () => {
    const idx = buildQualifiedNameIndex([
      makeDef({ nodeId: 'def:A', qualifiedName: 'app.A' }),
      makeDef({ nodeId: 'def:B', qualifiedName: 'app.B' }),
    ]);
    const names = Array.from(idx.byQualifiedName.keys()).sort();
    expect(names).toEqual(['app.A', 'app.B']);
  });
});
