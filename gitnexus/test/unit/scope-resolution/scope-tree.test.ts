/**
 * Unit tests for `buildScopeTree` / `ScopeTree` (RFC #909 Ring 2 SHARED #912).
 *
 * Covers: empty tree, single-module tree, nested module→class→function,
 * siblings, ancestors walk, children lookup, readonly surface, and all six
 * invariant violations (non-module without parent, parent not found, parent
 * doesn't contain child, siblings overlap, cross-file parent, duplicate id).
 * Also confirms that a `ScopeTree` satisfies the `ScopeLookup` contract from
 * #916 so `resolveTypeRef` can consume it directly.
 */

import { describe, it, expect } from 'vitest';
import {
  buildScopeTree,
  ScopeTreeInvariantError,
  resolveTypeRef,
  buildDefIndex,
  buildQualifiedNameIndex,
  type BindingRef,
  type Range,
  type Scope,
  type ScopeId,
  type ScopeKind,
  type SymbolDefinition,
} from 'gitnexus-shared';

// ─── Test helpers ───────────────────────────────────────────────────────────

const r = (startLine: number, startCol: number, endLine: number, endCol: number): Range => ({
  startLine,
  startCol,
  endLine,
  endCol,
});

interface ScopeFixture {
  id: ScopeId;
  parent: ScopeId | null;
  kind: ScopeKind;
  range: Range;
  filePath?: string;
  bindings?: Record<string, readonly BindingRef[]>;
}

const mkScope = (f: ScopeFixture): Scope => ({
  id: f.id,
  parent: f.parent,
  kind: f.kind,
  range: f.range,
  filePath: f.filePath ?? 'src/test.ts',
  bindings: new Map(Object.entries(f.bindings ?? {})),
  ownedDefs: [],
  imports: [],
  typeBindings: new Map(),
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildScopeTree', () => {
  describe('shape + lookup', () => {
    it('builds an empty tree from no scopes', () => {
      const tree = buildScopeTree([]);
      expect(tree.size).toBe(0);
      expect(tree.has('scope:missing')).toBe(false);
      expect(tree.getScope('scope:missing')).toBeUndefined();
      expect(tree.getParent('scope:missing')).toBeUndefined();
      expect(tree.getChildren('scope:missing')).toEqual([]);
      expect(tree.getAncestors('scope:missing')).toEqual([]);
    });

    it('round-trips a single module scope', () => {
      const m = mkScope({ id: 'scope:m', parent: null, kind: 'Module', range: r(1, 0, 100, 0) });
      const tree = buildScopeTree([m]);
      expect(tree.size).toBe(1);
      expect(tree.has('scope:m')).toBe(true);
      expect(tree.getScope('scope:m')).toBe(m);
      expect(tree.getParent('scope:m')).toBeUndefined();
      expect(tree.getChildren('scope:m')).toEqual([]);
      expect(tree.getAncestors('scope:m')).toEqual([]);
    });

    it('tracks parent/children for a nested module → class → function tree', () => {
      const mod = mkScope({ id: 'scope:m', parent: null, kind: 'Module', range: r(1, 0, 50, 0) });
      const cls = mkScope({
        id: 'scope:c',
        parent: 'scope:m',
        kind: 'Class',
        range: r(5, 0, 40, 0),
      });
      const fn = mkScope({
        id: 'scope:f',
        parent: 'scope:c',
        kind: 'Function',
        range: r(10, 2, 30, 2),
      });
      const tree = buildScopeTree([mod, cls, fn]);

      expect(tree.size).toBe(3);
      expect(tree.getParent('scope:f')).toBe(cls);
      expect(tree.getParent('scope:c')).toBe(mod);
      expect(tree.getChildren('scope:m')).toEqual(['scope:c']);
      expect(tree.getChildren('scope:c')).toEqual(['scope:f']);
      expect(tree.getAncestors('scope:f')).toEqual(['scope:c', 'scope:m']);
      expect(tree.getAncestors('scope:c')).toEqual(['scope:m']);
    });

    it('records multiple siblings in input order', () => {
      const mod = mkScope({ id: 'scope:m', parent: null, kind: 'Module', range: r(1, 0, 100, 0) });
      const fn1 = mkScope({
        id: 'scope:f1',
        parent: 'scope:m',
        kind: 'Function',
        range: r(5, 0, 10, 0),
      });
      const fn2 = mkScope({
        id: 'scope:f2',
        parent: 'scope:m',
        kind: 'Function',
        range: r(15, 0, 20, 0),
      });
      const fn3 = mkScope({
        id: 'scope:f3',
        parent: 'scope:m',
        kind: 'Function',
        range: r(25, 0, 30, 0),
      });
      const tree = buildScopeTree([mod, fn2, fn1, fn3]); // deliberately out of order
      expect(tree.getChildren('scope:m')).toEqual(['scope:f2', 'scope:f1', 'scope:f3']);
    });
  });

  describe('ScopeLookup compatibility (#916)', () => {
    it('resolveTypeRef can consume a ScopeTree directly', () => {
      const userClass: SymbolDefinition = {
        nodeId: 'def:User',
        filePath: 'src/test.ts',
        type: 'Class',
      };
      const module = mkScope({
        id: 'scope:m',
        parent: null,
        kind: 'Module',
        range: r(1, 0, 100, 0),
        bindings: { User: [{ def: userClass, origin: 'local' }] },
      });
      const fn = mkScope({
        id: 'scope:f',
        parent: 'scope:m',
        kind: 'Function',
        range: r(5, 0, 10, 0),
      });

      const tree = buildScopeTree([module, fn]);
      const result = resolveTypeRef(
        { rawName: 'User', declaredAtScope: 'scope:f', source: 'parameter-annotation' },
        {
          scopes: tree,
          defIndex: buildDefIndex([userClass]),
          qualifiedNameIndex: buildQualifiedNameIndex([userClass]),
        },
      );
      expect(result).toBe(userClass);
    });
  });

  describe('readonly surface', () => {
    it('freezes children arrays', () => {
      const mod = mkScope({ id: 'scope:m', parent: null, kind: 'Module', range: r(1, 0, 50, 0) });
      const fn = mkScope({
        id: 'scope:f',
        parent: 'scope:m',
        kind: 'Function',
        range: r(5, 0, 10, 0),
      });
      const tree = buildScopeTree([mod, fn]);
      const children = tree.getChildren('scope:m');
      expect(() => (children as unknown as ScopeId[]).push('x')).toThrow();
    });

    it('freezes ancestor arrays', () => {
      const mod = mkScope({ id: 'scope:m', parent: null, kind: 'Module', range: r(1, 0, 50, 0) });
      const fn = mkScope({
        id: 'scope:f',
        parent: 'scope:m',
        kind: 'Function',
        range: r(5, 0, 10, 0),
      });
      const tree = buildScopeTree([mod, fn]);
      const ancestors = tree.getAncestors('scope:f');
      expect(() => (ancestors as unknown as ScopeId[]).push('x')).toThrow();
    });
  });

  describe('invariant violations', () => {
    it('throws when a non-Module scope has a null parent', () => {
      const orphan = mkScope({
        id: 'scope:f',
        parent: null,
        kind: 'Function',
        range: r(1, 0, 5, 0),
      });
      expect(() => buildScopeTree([orphan])).toThrowError(ScopeTreeInvariantError);
      expect(() => buildScopeTree([orphan])).toThrowError(/Module/);
    });

    it('throws when a parent pointer references a scope not in the tree', () => {
      const fn = mkScope({
        id: 'scope:f',
        parent: 'scope:ghost',
        kind: 'Function',
        range: r(1, 0, 5, 0),
      });
      expect(() => buildScopeTree([fn])).toThrowError(ScopeTreeInvariantError);
    });

    it('throws when a parent range does not strictly contain a child range', () => {
      const mod = mkScope({ id: 'scope:m', parent: null, kind: 'Module', range: r(1, 0, 10, 0) });
      const fn = mkScope({
        id: 'scope:f',
        parent: 'scope:m',
        kind: 'Function',
        range: r(5, 0, 50, 0), // extends beyond the module
      });
      expect(() => buildScopeTree([mod, fn])).toThrowError(ScopeTreeInvariantError);
      expect(() => buildScopeTree([mod, fn])).toThrowError(/strictly contain/i);
    });

    it('rejects child ranges identical to the parent (not strictly contained)', () => {
      const mod = mkScope({ id: 'scope:m', parent: null, kind: 'Module', range: r(1, 0, 10, 0) });
      const fn = mkScope({
        id: 'scope:f',
        parent: 'scope:m',
        kind: 'Function',
        range: r(1, 0, 10, 0),
      });
      expect(() => buildScopeTree([mod, fn])).toThrowError(ScopeTreeInvariantError);
    });

    it('throws when sibling ranges overlap', () => {
      const mod = mkScope({ id: 'scope:m', parent: null, kind: 'Module', range: r(1, 0, 100, 0) });
      const a = mkScope({
        id: 'scope:a',
        parent: 'scope:m',
        kind: 'Function',
        range: r(5, 0, 20, 0),
      });
      const b = mkScope({
        id: 'scope:b',
        parent: 'scope:m',
        kind: 'Function',
        range: r(15, 0, 30, 0), // overlaps with a
      });
      expect(() => buildScopeTree([mod, a, b])).toThrowError(ScopeTreeInvariantError);
      expect(() => buildScopeTree([mod, a, b])).toThrowError(/overlap/i);
    });

    it('accepts sibling ranges that merely touch at the boundary', () => {
      const mod = mkScope({ id: 'scope:m', parent: null, kind: 'Module', range: r(1, 0, 100, 0) });
      const a = mkScope({
        id: 'scope:a',
        parent: 'scope:m',
        kind: 'Block',
        range: r(5, 0, 10, 0),
      });
      const b = mkScope({
        id: 'scope:b',
        parent: 'scope:m',
        kind: 'Block',
        range: r(10, 0, 15, 0), // touches a at 10:0 but does not overlap
      });
      expect(() => buildScopeTree([mod, a, b])).not.toThrow();
    });

    it('throws when parent and child live in different files', () => {
      const mod = mkScope({
        id: 'scope:m',
        parent: null,
        kind: 'Module',
        range: r(1, 0, 100, 0),
        filePath: 'a.ts',
      });
      const fn = mkScope({
        id: 'scope:f',
        parent: 'scope:m',
        kind: 'Function',
        range: r(5, 0, 10, 0),
        filePath: 'b.ts',
      });
      expect(() => buildScopeTree([mod, fn])).toThrowError(ScopeTreeInvariantError);
      expect(() => buildScopeTree([mod, fn])).toThrowError(/filePath/i);
    });

    it('throws on duplicate scope ids', () => {
      const a = mkScope({ id: 'scope:dup', parent: null, kind: 'Module', range: r(1, 0, 10, 0) });
      const b = mkScope({ id: 'scope:dup', parent: null, kind: 'Module', range: r(1, 0, 10, 0) });
      expect(() => buildScopeTree([a, b])).toThrowError(ScopeTreeInvariantError);
    });
  });
});
