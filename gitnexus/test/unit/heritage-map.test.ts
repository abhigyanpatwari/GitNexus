import { describe, it, expect, beforeEach } from 'vitest';
import { buildHeritageMap } from '../../src/core/ingestion/heritage-map.js';
import {
  createResolutionContext,
  type ResolutionContext,
} from '../../src/core/ingestion/resolution-context.js';
import type { ExtractedHeritage } from '../../src/core/ingestion/workers/parse-worker.js';

describe('buildHeritageMap', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  // ── getParents ──────────────────────────────────────────────────────

  describe('getParents', () => {
    it('returns direct parents for a single extends relationship', () => {
      ctx.symbols.add('src/child.ts', 'Child', 'class:Child', 'Class');
      ctx.symbols.add('src/parent.ts', 'Parent', 'class:Parent', 'Class');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/child.ts', className: 'Child', parentName: 'Parent', kind: 'extends' },
      ];

      const map = buildHeritageMap(heritage, ctx);
      expect(map.getParents('class:Child')).toEqual(['class:Parent']);
    });

    it('returns direct parents for implements relationship', () => {
      ctx.symbols.add('src/service.ts', 'Service', 'class:Service', 'Class');
      ctx.symbols.add('src/iface.ts', 'IService', 'iface:IService', 'Interface');

      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/service.ts',
          className: 'Service',
          parentName: 'IService',
          kind: 'implements',
        },
      ];

      const map = buildHeritageMap(heritage, ctx);
      expect(map.getParents('class:Service')).toEqual(['iface:IService']);
    });

    it('returns direct parents for trait-impl relationship', () => {
      ctx.symbols.add('src/point.rs', 'Point', 'struct:Point', 'Struct');
      ctx.symbols.add('src/display.rs', 'Display', 'trait:Display', 'Interface');

      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/point.rs',
          className: 'Point',
          parentName: 'Display',
          kind: 'trait-impl',
        },
      ];

      const map = buildHeritageMap(heritage, ctx);
      expect(map.getParents('struct:Point')).toEqual(['trait:Display']);
    });

    it('returns multiple parents when class extends and implements', () => {
      ctx.symbols.add('src/admin.ts', 'Admin', 'class:Admin', 'Class');
      ctx.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
      ctx.symbols.add('src/serializable.ts', 'Serializable', 'iface:Serializable', 'Interface');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/admin.ts', className: 'Admin', parentName: 'User', kind: 'extends' },
        {
          filePath: 'src/admin.ts',
          className: 'Admin',
          parentName: 'Serializable',
          kind: 'implements',
        },
      ];

      const map = buildHeritageMap(heritage, ctx);
      const parents = map.getParents('class:Admin');
      expect(parents).toHaveLength(2);
      expect(parents).toContain('class:User');
      expect(parents).toContain('iface:Serializable');
    });

    it('returns empty array for unknown nodeId', () => {
      const map = buildHeritageMap([], ctx);
      expect(map.getParents('class:NonExistent')).toEqual([]);
    });

    it('skips heritage records where child class is not in symbol table', () => {
      ctx.symbols.add('src/parent.ts', 'Parent', 'class:Parent', 'Class');

      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/child.ts',
          className: 'Unknown',
          parentName: 'Parent',
          kind: 'extends',
        },
      ];

      const map = buildHeritageMap(heritage, ctx);
      // No child resolved, so no entries
      expect(map.getParents('class:Parent')).toEqual([]);
    });

    it('skips heritage records where parent class is not in symbol table', () => {
      ctx.symbols.add('src/child.ts', 'Child', 'class:Child', 'Class');

      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/child.ts',
          className: 'Child',
          parentName: 'Unknown',
          kind: 'extends',
        },
      ];

      const map = buildHeritageMap(heritage, ctx);
      expect(map.getParents('class:Child')).toEqual([]);
    });

    it('skips self-references', () => {
      ctx.symbols.add('src/a.ts', 'A', 'class:A', 'Class');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/a.ts', className: 'A', parentName: 'A', kind: 'extends' },
      ];

      const map = buildHeritageMap(heritage, ctx);
      expect(map.getParents('class:A')).toEqual([]);
    });

    it('deduplicates cross-chunk duplicates', () => {
      ctx.symbols.add('src/child.ts', 'Child', 'class:Child', 'Class');
      ctx.symbols.add('src/parent.ts', 'Parent', 'class:Parent', 'Class');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/child.ts', className: 'Child', parentName: 'Parent', kind: 'extends' },
        { filePath: 'src/child.ts', className: 'Child', parentName: 'Parent', kind: 'extends' },
      ];

      const map = buildHeritageMap(heritage, ctx);
      expect(map.getParents('class:Child')).toEqual(['class:Parent']);
    });
  });

  // ── getAncestors ────────────────────────────────────────────────────

  describe('getAncestors', () => {
    it('returns full ancestor chain for multi-level inheritance', () => {
      ctx.symbols.add('src/c.ts', 'C', 'class:C', 'Class');
      ctx.symbols.add('src/b.ts', 'B', 'class:B', 'Class');
      ctx.symbols.add('src/a.ts', 'A', 'class:A', 'Class');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/c.ts', className: 'C', parentName: 'B', kind: 'extends' },
        { filePath: 'src/b.ts', className: 'B', parentName: 'A', kind: 'extends' },
      ];

      const map = buildHeritageMap(heritage, ctx);
      const ancestors = map.getAncestors('class:C');
      expect(ancestors).toHaveLength(2);
      expect(ancestors).toContain('class:B');
      expect(ancestors).toContain('class:A');
    });

    it('handles diamond inheritance without duplicates', () => {
      //     A
      //    / \
      //   B   C
      //    \ /
      //     D
      ctx.symbols.add('src/a.ts', 'A', 'class:A', 'Class');
      ctx.symbols.add('src/b.ts', 'B', 'class:B', 'Class');
      ctx.symbols.add('src/c.ts', 'C', 'class:C', 'Class');
      ctx.symbols.add('src/d.ts', 'D', 'class:D', 'Class');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/d.ts', className: 'D', parentName: 'B', kind: 'extends' },
        { filePath: 'src/d.ts', className: 'D', parentName: 'C', kind: 'implements' },
        { filePath: 'src/b.ts', className: 'B', parentName: 'A', kind: 'extends' },
        { filePath: 'src/c.ts', className: 'C', parentName: 'A', kind: 'extends' },
      ];

      const map = buildHeritageMap(heritage, ctx);
      const ancestors = map.getAncestors('class:D');
      expect(ancestors).toHaveLength(3); // B, C, A — no duplicates
      expect(ancestors).toContain('class:B');
      expect(ancestors).toContain('class:C');
      expect(ancestors).toContain('class:A');
    });

    it('protects against cycles', () => {
      ctx.symbols.add('src/a.ts', 'A', 'class:A', 'Class');
      ctx.symbols.add('src/b.ts', 'B', 'class:B', 'Class');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/a.ts', className: 'A', parentName: 'B', kind: 'extends' },
        { filePath: 'src/b.ts', className: 'B', parentName: 'A', kind: 'extends' },
      ];

      const map = buildHeritageMap(heritage, ctx);
      // Should not infinite-loop; each visited once
      const ancestorsA = map.getAncestors('class:A');
      expect(ancestorsA).toEqual(['class:B']);

      const ancestorsB = map.getAncestors('class:B');
      expect(ancestorsB).toEqual(['class:A']);
    });

    it('protects against multi-node cycles (A→B→C→A)', () => {
      ctx.symbols.add('src/a.ts', 'A', 'class:A', 'Class');
      ctx.symbols.add('src/b.ts', 'B', 'class:B', 'Class');
      ctx.symbols.add('src/c.ts', 'C', 'class:C', 'Class');

      // A → B → C → A (3-node cycle)
      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/a.ts', className: 'A', parentName: 'B', kind: 'extends' },
        { filePath: 'src/b.ts', className: 'B', parentName: 'C', kind: 'extends' },
        { filePath: 'src/c.ts', className: 'C', parentName: 'A', kind: 'extends' },
      ];

      const map = buildHeritageMap(heritage, ctx);
      const ancestors = map.getAncestors('class:A');
      // Should visit B and C but not loop back to A
      expect(ancestors).toHaveLength(2);
      expect(ancestors).toContain('class:B');
      expect(ancestors).toContain('class:C');
    });

    it('returns empty array for node with no parents', () => {
      ctx.symbols.add('src/a.ts', 'A', 'class:A', 'Class');

      const map = buildHeritageMap([], ctx);
      expect(map.getAncestors('class:A')).toEqual([]);
    });

    it('returns empty array for unknown nodeId', () => {
      const map = buildHeritageMap([], ctx);
      expect(map.getAncestors('class:NonExistent')).toEqual([]);
    });

    it('handles deep inheritance chain (bounded depth)', () => {
      // Build a chain of 40 levels — should be bounded by MAX_ANCESTOR_DEPTH (32)
      const heritage: ExtractedHeritage[] = [];
      for (let i = 0; i < 40; i++) {
        const childName = `Level${i}`;
        const parentName = `Level${i + 1}`;
        ctx.symbols.add(`src/${childName}.ts`, childName, `class:${childName}`, 'Class');
        if (i === 39) {
          ctx.symbols.add(`src/${parentName}.ts`, parentName, `class:${parentName}`, 'Class');
        }
        heritage.push({
          filePath: `src/${childName}.ts`,
          className: childName,
          parentName: parentName,
          kind: 'extends',
        });
      }

      const map = buildHeritageMap(heritage, ctx);
      const ancestors = map.getAncestors('class:Level0');
      // Should have at most 32 ancestors (bounded), not all 40
      expect(ancestors.length).toBeLessThanOrEqual(32);
      expect(ancestors.length).toBeGreaterThan(0);
      // First ancestor should be the direct parent
      expect(ancestors[0]).toBe('class:Level1');
    });
  });

  // ── empty heritage ──────────────────────────────────────────────────

  describe('empty heritage', () => {
    it('returns empty results for empty heritage array', () => {
      const map = buildHeritageMap([], ctx);
      expect(map.getParents('any')).toEqual([]);
      expect(map.getAncestors('any')).toEqual([]);
    });
  });

  // ── chunk-order invariant ───────────────────────────────────────────

  describe('chunk-order invariant', () => {
    it('produces same result regardless of heritage record order', () => {
      ctx.symbols.add('src/d.ts', 'D', 'class:D', 'Class');
      ctx.symbols.add('src/c.ts', 'C', 'class:C', 'Class');
      ctx.symbols.add('src/b.ts', 'B', 'class:B', 'Class');
      ctx.symbols.add('src/a.ts', 'A', 'class:A', 'Class');

      const heritage1: ExtractedHeritage[] = [
        { filePath: 'src/d.ts', className: 'D', parentName: 'C', kind: 'extends' },
        { filePath: 'src/c.ts', className: 'C', parentName: 'B', kind: 'extends' },
        { filePath: 'src/b.ts', className: 'B', parentName: 'A', kind: 'extends' },
      ];

      const heritage2: ExtractedHeritage[] = [
        { filePath: 'src/b.ts', className: 'B', parentName: 'A', kind: 'extends' },
        { filePath: 'src/d.ts', className: 'D', parentName: 'C', kind: 'extends' },
        { filePath: 'src/c.ts', className: 'C', parentName: 'B', kind: 'extends' },
      ];

      const map1 = buildHeritageMap(heritage1, ctx);
      const map2 = buildHeritageMap(heritage2, ctx);

      expect(map1.getParents('class:D').sort()).toEqual(map2.getParents('class:D').sort());
      expect(map1.getAncestors('class:D').sort()).toEqual(map2.getAncestors('class:D').sort());
    });
  });
});
