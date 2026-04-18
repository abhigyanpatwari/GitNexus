/**
 * Unit tests for `buildMethodDispatchIndex` / `MethodDispatchIndex`
 * (RFC #909 Ring 2 SHARED #914).
 *
 * Covers: empty input, single-inheritance chain, diamond inheritance (caller-
 * determined MRO order), interface-only dispatch, multiple implementors,
 * dedup, first-write-wins, C3 vs BFS strategy parity (both honored verbatim),
 * readonly surface + frozen output.
 */

import { describe, it, expect } from 'vitest';
import { buildMethodDispatchIndex, type MethodDispatchInput, type DefId } from 'gitnexus-shared';

// ─── Test helpers ───────────────────────────────────────────────────────────

const input = (
  owners: readonly DefId[],
  mroByOwner: Record<DefId, readonly DefId[]>,
  implementsByOwner: Record<DefId, readonly DefId[]> = {},
): MethodDispatchInput => ({
  owners,
  computeMro: (owner) => mroByOwner[owner] ?? [],
  implementsOf: (owner) => implementsByOwner[owner] ?? [],
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildMethodDispatchIndex', () => {
  describe('empty / degenerate inputs', () => {
    it('builds an empty index from no owners', () => {
      const idx = buildMethodDispatchIndex(input([], {}));
      expect(idx.mroByOwnerDefId.size).toBe(0);
      expect(idx.implsByInterfaceDefId.size).toBe(0);
      expect(idx.mroFor('anything')).toEqual([]);
      expect(idx.implementorsOf('anything')).toEqual([]);
    });

    it('indexes an owner with no parents and no interfaces', () => {
      const idx = buildMethodDispatchIndex(input(['def:A'], { 'def:A': [] }));
      expect(idx.mroByOwnerDefId.size).toBe(1);
      expect(idx.implsByInterfaceDefId.size).toBe(0);
      expect(idx.mroFor('def:A')).toEqual([]);
    });
  });

  describe('MRO materialization (single / multi inheritance)', () => {
    it('records a single-inheritance chain verbatim from the callback', () => {
      // A extends B extends C
      const idx = buildMethodDispatchIndex(
        input(['def:A', 'def:B', 'def:C'], {
          'def:A': ['def:B', 'def:C'],
          'def:B': ['def:C'],
          'def:C': [],
        }),
      );
      expect(idx.mroFor('def:A')).toEqual(['def:B', 'def:C']);
      expect(idx.mroFor('def:B')).toEqual(['def:C']);
      expect(idx.mroFor('def:C')).toEqual([]);
    });

    it('records a C3 linearization verbatim (Python diamond)', () => {
      // D(B, C) where B(A), C(A). Classical C3 keeps A last because the
      // merge step defers A until both B and C have been emitted.
      // Our index stores MRO excluding self: [B, C, A].
      const idx = buildMethodDispatchIndex(
        input(['def:D'], { 'def:D': ['def:B', 'def:C', 'def:A'] }),
      );
      expect(idx.mroFor('def:D')).toEqual(['def:B', 'def:C', 'def:A']);
    });

    it('records a BFS linearization verbatim (Java-style first-wins)', () => {
      // Same class hierarchy as the C3 case, but the BFS walker visits
      // A before C via the B→A edge. Expected MRO differs from C3: [B, A, C].
      // This test proves the materializer preserves whatever ordering the
      // per-language `computeMro` callback produces — NOT that C3 and BFS
      // produce identical output.
      const idx = buildMethodDispatchIndex(
        input(['def:D'], { 'def:D': ['def:B', 'def:A', 'def:C'] }),
      );
      expect(idx.mroFor('def:D')).toEqual(['def:B', 'def:A', 'def:C']);
    });

    it('records a Ruby-style kind-aware ancestry verbatim', () => {
      // class C prepend P1 prepend P2; include M1 include M2
      // ruby-mixin walk order (per callback): [P2, P1, M2, M1]
      const idx = buildMethodDispatchIndex(
        input(['def:C'], { 'def:C': ['def:P2', 'def:P1', 'def:M2', 'def:M1'] }),
      );
      expect(idx.mroFor('def:C')).toEqual(['def:P2', 'def:P1', 'def:M2', 'def:M1']);
    });

    it('records an empty chain for Rust qualified-syntax owners', () => {
      // Rust: no auto-MRO; callback returns []
      const idx = buildMethodDispatchIndex(input(['def:RustStruct'], { 'def:RustStruct': [] }));
      expect(idx.mroFor('def:RustStruct')).toEqual([]);
    });
  });

  describe('implements inversion', () => {
    it('inverts a single class → interface mapping', () => {
      const idx = buildMethodDispatchIndex(
        input(['def:Impl'], { 'def:Impl': [] }, { 'def:Impl': ['def:IFace'] }),
      );
      expect(idx.implementorsOf('def:IFace')).toEqual(['def:Impl']);
    });

    it('aggregates multiple classes implementing the same interface', () => {
      const idx = buildMethodDispatchIndex(
        input(
          ['def:A', 'def:B', 'def:C'],
          { 'def:A': [], 'def:B': [], 'def:C': [] },
          { 'def:A': ['def:I'], 'def:B': ['def:I'], 'def:C': ['def:J'] },
        ),
      );
      expect(idx.implementorsOf('def:I')).toEqual(['def:A', 'def:B']);
      expect(idx.implementorsOf('def:J')).toEqual(['def:C']);
    });

    it('preserves iteration order of owners in each implementors bucket', () => {
      const idx = buildMethodDispatchIndex(
        input(
          ['def:Z', 'def:Y', 'def:X'],
          { 'def:Z': [], 'def:Y': [], 'def:X': [] },
          { 'def:Z': ['def:I'], 'def:Y': ['def:I'], 'def:X': ['def:I'] },
        ),
      );
      expect(idx.implementorsOf('def:I')).toEqual(['def:Z', 'def:Y', 'def:X']);
    });

    it('deduplicates repeated (interface, owner) pairs within a single callback call', () => {
      // Caller may legally return the same interface twice (e.g., a class that
      // both `implements IFace` and inherits from a parent that also does).
      const idx = buildMethodDispatchIndex(
        input(['def:Impl'], { 'def:Impl': [] }, { 'def:Impl': ['def:I', 'def:I', 'def:I'] }),
      );
      expect(idx.implementorsOf('def:I')).toEqual(['def:Impl']);
    });

    it('deduplicates when the same owner is listed in `owners` twice (first-write-wins)', () => {
      // First-write-wins parity with sibling indexes; subsequent owner entries
      // should not re-invoke `computeMro` for existing MRO, and should not
      // create duplicate implementor entries.
      //
      // NOTE on `implementsOf` call count: the builder calls `implementsOf`
      // ONCE PER OCCURRENCE of an owner in `input.owners`, not once per
      // unique owner. Duplicate owners therefore re-invoke `implementsOf`;
      // the dedup lives at the bucket layer (via `implsSeen`), not the
      // callback layer. Callers with expensive `implementsOf` callbacks
      // should dedupe `input.owners` upfront. This counter assertion pins
      // that contract so a future refactor can't silently collapse the
      // second call without updating the docstring.
      let mroCalls = 0;
      let implementsOfCalls = 0;
      const impls: Record<DefId, readonly DefId[]> = { 'def:A': ['def:I'] };
      const idx = buildMethodDispatchIndex({
        owners: ['def:A', 'def:A'],
        computeMro: (_) => {
          mroCalls++;
          return ['def:B'];
        },
        implementsOf: (o) => {
          implementsOfCalls++;
          return impls[o] ?? [];
        },
      });
      expect(mroCalls).toBe(1); // MRO dedup is at the callback layer (first-write-wins)
      expect(implementsOfCalls).toBe(2); // implementsOf fires per occurrence; dedup at bucket
      expect(idx.mroFor('def:A')).toEqual(['def:B']);
      expect(idx.implementorsOf('def:I')).toEqual(['def:A']);
    });
  });

  describe('lookup miss / safety surface', () => {
    it('returns a frozen empty array on MRO miss', () => {
      const idx = buildMethodDispatchIndex(input(['def:A'], { 'def:A': [] }));
      const miss = idx.mroFor('def:Missing');
      expect(miss).toEqual([]);
      expect(() => (miss as unknown as DefId[]).push('x')).toThrow();
    });

    it('returns a frozen empty array on implementors miss', () => {
      const idx = buildMethodDispatchIndex(input(['def:A'], { 'def:A': [] }));
      const miss = idx.implementorsOf('def:Missing');
      expect(miss).toEqual([]);
      expect(() => (miss as unknown as DefId[]).push('x')).toThrow();
    });

    it('freezes stored MRO arrays (readonly surface)', () => {
      const idx = buildMethodDispatchIndex(input(['def:A'], { 'def:A': ['def:B'] }));
      const chain = idx.mroFor('def:A');
      expect(() => (chain as unknown as DefId[]).push('x')).toThrow();
    });

    it('freezes stored implementors arrays (readonly surface)', () => {
      const idx = buildMethodDispatchIndex(
        input(['def:A'], { 'def:A': [] }, { 'def:A': ['def:I'] }),
      );
      const impls = idx.implementorsOf('def:I');
      expect(() => (impls as unknown as DefId[]).push('x')).toThrow();
    });

    it('isolates stored MRO from later mutation of the callback-returned array', () => {
      const mutable = ['def:B', 'def:C'];
      const idx = buildMethodDispatchIndex({
        owners: ['def:A'],
        computeMro: () => mutable,
        implementsOf: () => [],
      });
      mutable.push('def:D');
      expect(idx.mroFor('def:A')).toEqual(['def:B', 'def:C']);
    });
  });

  describe('readonly surface', () => {
    it('exposes `mroByOwnerDefId` as a read-only Map for direct iteration', () => {
      const idx = buildMethodDispatchIndex(
        input(['def:A', 'def:B'], { 'def:A': [], 'def:B': ['def:A'] }),
      );
      const owners = Array.from(idx.mroByOwnerDefId.keys()).sort();
      expect(owners).toEqual(['def:A', 'def:B']);
    });

    it('exposes `implsByInterfaceDefId` as a read-only Map for direct iteration', () => {
      const idx = buildMethodDispatchIndex(
        input(
          ['def:A', 'def:B'],
          { 'def:A': [], 'def:B': [] },
          { 'def:A': ['def:I'], 'def:B': ['def:J'] },
        ),
      );
      const keys = Array.from(idx.implsByInterfaceDefId.keys()).sort();
      expect(keys).toEqual(['def:I', 'def:J']);
    });
  });
});
