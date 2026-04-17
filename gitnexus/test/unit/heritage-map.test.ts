import { describe, it, expect, beforeEach } from 'vitest';
import { buildHeritageMap } from '../../src/core/ingestion/model/heritage-map.js';
import {
  createResolutionContext,
  type ResolutionContext,
} from '../../src/core/ingestion/model/resolution-context.js';
import type { ExtractedHeritage } from '../../src/core/ingestion/model/heritage-map.js';
import { getHeritageStrategyForLanguage } from '../../src/core/ingestion/heritage-processor.js';

describe('buildHeritageMap', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  // ── getParents ──────────────────────────────────────────────────────

  describe('getParents', () => {
    it('returns direct parents for a single extends relationship', () => {
      ctx.model.symbols.add('src/child.ts', 'Child', 'class:Child', 'Class');
      ctx.model.symbols.add('src/parent.ts', 'Parent', 'class:Parent', 'Class');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/child.ts', className: 'Child', parentName: 'Parent', kind: 'extends' },
      ];

      const map = buildHeritageMap(heritage, ctx);
      expect(map.getParents('class:Child')).toEqual(['class:Parent']);
    });

    it('returns direct parents for implements relationship', () => {
      ctx.model.symbols.add('src/service.ts', 'Service', 'class:Service', 'Class');
      ctx.model.symbols.add('src/iface.ts', 'IService', 'iface:IService', 'Interface');

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
      ctx.model.symbols.add('src/point.rs', 'Point', 'struct:Point', 'Struct');
      ctx.model.symbols.add('src/display.rs', 'Display', 'trait:Display', 'Interface');

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
      ctx.model.symbols.add('src/admin.ts', 'Admin', 'class:Admin', 'Class');
      ctx.model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
      ctx.model.symbols.add(
        'src/serializable.ts',
        'Serializable',
        'iface:Serializable',
        'Interface',
      );

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
      ctx.model.symbols.add('src/parent.ts', 'Parent', 'class:Parent', 'Class');

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
      ctx.model.symbols.add('src/child.ts', 'Child', 'class:Child', 'Class');

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
      ctx.model.symbols.add('src/a.ts', 'A', 'class:A', 'Class');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/a.ts', className: 'A', parentName: 'A', kind: 'extends' },
      ];

      const map = buildHeritageMap(heritage, ctx);
      expect(map.getParents('class:A')).toEqual([]);
    });

    it('deduplicates cross-chunk duplicates', () => {
      ctx.model.symbols.add('src/child.ts', 'Child', 'class:Child', 'Class');
      ctx.model.symbols.add('src/parent.ts', 'Parent', 'class:Parent', 'Class');

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
      ctx.model.symbols.add('src/c.ts', 'C', 'class:C', 'Class');
      ctx.model.symbols.add('src/b.ts', 'B', 'class:B', 'Class');
      ctx.model.symbols.add('src/a.ts', 'A', 'class:A', 'Class');

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
      ctx.model.symbols.add('src/a.ts', 'A', 'class:A', 'Class');
      ctx.model.symbols.add('src/b.ts', 'B', 'class:B', 'Class');
      ctx.model.symbols.add('src/c.ts', 'C', 'class:C', 'Class');
      ctx.model.symbols.add('src/d.ts', 'D', 'class:D', 'Class');

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
      ctx.model.symbols.add('src/a.ts', 'A', 'class:A', 'Class');
      ctx.model.symbols.add('src/b.ts', 'B', 'class:B', 'Class');

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
      ctx.model.symbols.add('src/a.ts', 'A', 'class:A', 'Class');
      ctx.model.symbols.add('src/b.ts', 'B', 'class:B', 'Class');
      ctx.model.symbols.add('src/c.ts', 'C', 'class:C', 'Class');

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
      ctx.model.symbols.add('src/a.ts', 'A', 'class:A', 'Class');

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
        ctx.model.symbols.add(`src/${childName}.ts`, childName, `class:${childName}`, 'Class');
        if (i === 39) {
          ctx.model.symbols.add(`src/${parentName}.ts`, parentName, `class:${parentName}`, 'Class');
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
      // Strictly linear chain of depth > MAX_ANCESTOR_DEPTH must terminate
      // at exactly 32 BFS iterations. The tight `toBe(32)` guards against a
      // future regression that silently returns fewer ancestors.
      expect(ancestors.length).toBe(32);
      // First ancestor should be the direct parent
      expect(ancestors[0]).toBe('class:Level1');
      // Last ancestor should be the 32nd level — beyond that is cut off
      expect(ancestors[31]).toBe('class:Level32');
    });
  });

  // ── empty heritage ──────────────────────────────────────────────────

  describe('empty heritage', () => {
    it('returns empty results for empty heritage array', () => {
      const map = buildHeritageMap([], ctx);
      expect(map.getParents('any')).toEqual([]);
      expect(map.getAncestors('any')).toEqual([]);
      expect(map.getImplementorFiles('any').size).toBe(0);
    });
  });

  // ── getImplementorFiles ─────────────────────────────────────────────

  describe('getImplementorFiles', () => {
    it('records direct implements edges per interface name', () => {
      ctx.model.symbols.add('a.java', 'C', 'class:C', 'Class');
      ctx.model.symbols.add('b.java', 'D', 'class:D', 'Class');
      ctx.model.symbols.add('iface.java', 'Runnable', 'iface:Runnable', 'Interface');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'a.java', className: 'C', parentName: 'Runnable', kind: 'implements' },
        { filePath: 'b.java', className: 'D', parentName: 'Runnable', kind: 'implements' },
      ];
      const map = buildHeritageMap(heritage, ctx);
      expect(map.getImplementorFiles('Runnable')).toEqual(new Set(['a.java', 'b.java']));
    });

    it('only records implementors for interface parents, not class parents', () => {
      ctx.model.symbols.add('a.java', 'C', 'class:C', 'Class');
      ctx.model.symbols.add('base.java', 'Base', 'class:Base', 'Class');
      ctx.model.symbols.add('iface.java', 'I', 'iface:I', 'Interface');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'a.java', className: 'C', parentName: 'Base', kind: 'extends' },
        { filePath: 'a.java', className: 'C', parentName: 'I', kind: 'implements' },
      ];
      const map = buildHeritageMap(heritage, ctx);
      expect(map.getImplementorFiles('Base').size).toBe(0);
      expect(map.getImplementorFiles('I')).toEqual(new Set(['a.java']));
    });

    it('returns empty set for unknown interface name', () => {
      const map = buildHeritageMap([], ctx);
      const result = map.getImplementorFiles('NonExistent');
      expect(result.size).toBe(0);
    });

    it('records C# extends→IMPLEMENTS via interfaceNamePattern when parent is unresolved', () => {
      // C# provider has interfaceNamePattern: /^I[A-Z]/.
      // Only the child class is registered; the parent interface has no symbol.
      // resolveExtendsType must fall through to the provider heuristic and
      // classify `IDisposable` as IMPLEMENTS.
      ctx.model.symbols.add('src/Service.cs', 'Service', 'class:Service', 'Class');

      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/Service.cs',
          className: 'Service',
          parentName: 'IDisposable',
          kind: 'extends',
        },
      ];
      const map = buildHeritageMap(heritage, ctx, getHeritageStrategyForLanguage);
      expect(map.getImplementorFiles('IDisposable')).toEqual(new Set(['src/Service.cs']));
    });

    it('records Swift extends→IMPLEMENTS via heritageDefaultEdge when parent is unresolved', () => {
      // Swift provider has heritageDefaultEdge: 'IMPLEMENTS'.
      // Unresolved parents should default to IMPLEMENTS (protocol conformance).
      ctx.model.symbols.add('src/MyView.swift', 'MyView', 'class:MyView', 'Class');

      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/MyView.swift',
          className: 'MyView',
          parentName: 'SomeProtocol',
          kind: 'extends',
        },
      ];
      const map = buildHeritageMap(heritage, ctx, getHeritageStrategyForLanguage);
      expect(map.getImplementorFiles('SomeProtocol')).toEqual(new Set(['src/MyView.swift']));
    });

    it('records Java extends→IMPLEMENTS when parent is registered as an Interface symbol', () => {
      // Java/C# path: when ctx.resolve finds a matching symbol whose type is
      // Interface, resolveExtendsType returns IMPLEMENTS via the symbol lookup
      // (not the interfaceNamePattern fallback).
      ctx.model.symbols.add('src/Impl.java', 'Impl', 'class:Impl', 'Class');
      ctx.model.symbols.add('src/MyContract.java', 'MyContract', 'iface:MyContract', 'Interface');

      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/Impl.java',
          className: 'Impl',
          parentName: 'MyContract',
          kind: 'extends',
        },
      ];
      const map = buildHeritageMap(heritage, ctx);
      expect(map.getImplementorFiles('MyContract')).toEqual(new Set(['src/Impl.java']));
    });

    it('records Kotlin implements edges', () => {
      ctx.model.symbols.add('src/Impl.kt', 'Impl', 'class:Impl', 'Class');
      ctx.model.symbols.add('src/Iface.kt', 'Iface', 'iface:Iface', 'Interface');

      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/Impl.kt',
          className: 'Impl',
          parentName: 'Iface',
          kind: 'implements',
        },
      ];
      const map = buildHeritageMap(heritage, ctx);
      expect(map.getImplementorFiles('Iface')).toEqual(new Set(['src/Impl.kt']));
    });

    it('records TypeScript implements edges', () => {
      ctx.model.symbols.add('src/Service.ts', 'UserService', 'class:UserService', 'Class');
      ctx.model.symbols.add('src/IService.ts', 'IUserService', 'iface:IUserService', 'Interface');

      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/Service.ts',
          className: 'UserService',
          parentName: 'IUserService',
          kind: 'implements',
        },
      ];
      const map = buildHeritageMap(heritage, ctx);
      expect(map.getImplementorFiles('IUserService')).toEqual(new Set(['src/Service.ts']));
    });

    it('records PHP implements edges', () => {
      ctx.model.symbols.add('src/Impl.php', 'Impl', 'class:Impl', 'Class');
      ctx.model.symbols.add('src/Iface.php', 'Iface', 'iface:Iface', 'Interface');

      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/Impl.php',
          className: 'Impl',
          parentName: 'Iface',
          kind: 'implements',
        },
      ];
      const map = buildHeritageMap(heritage, ctx);
      expect(map.getImplementorFiles('Iface')).toEqual(new Set(['src/Impl.php']));
    });

    it('does not record Rust trait-impl entries in the implementor index', () => {
      // Documented limitation: trait-impl is intentionally not added to the
      // implementor index — interface dispatch does not traverse trait objects.
      ctx.model.symbols.add('src/point.rs', 'Point', 'struct:Point', 'Struct');
      ctx.model.symbols.add('src/display.rs', 'Display', 'trait:Display', 'Interface');

      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/point.rs',
          className: 'Point',
          parentName: 'Display',
          kind: 'trait-impl',
        },
      ];
      const map = buildHeritageMap(heritage, ctx);
      expect(map.getImplementorFiles('Display').size).toBe(0);
      // Parent lookup still works — only the implementor index skips trait-impl.
      expect(map.getParents('struct:Point')).toEqual(['trait:Display']);
    });

    it('heritage merged across chunks matches single-pass (chunk-order invariant)', () => {
      ctx.model.symbols.add('a.java', 'A', 'class:A', 'Class');
      ctx.model.symbols.add('b.java', 'B', 'class:B', 'Class');
      ctx.model.symbols.add('iface.java', 'Iface', 'iface:Iface', 'Interface');

      const chunk1: ExtractedHeritage[] = [
        { filePath: 'a.java', className: 'A', parentName: 'Iface', kind: 'implements' },
      ];
      const chunk2: ExtractedHeritage[] = [
        { filePath: 'b.java', className: 'B', parentName: 'Iface', kind: 'implements' },
      ];
      const oneShot = buildHeritageMap([...chunk1, ...chunk2], ctx);
      expect(oneShot.getImplementorFiles('Iface')).toEqual(new Set(['a.java', 'b.java']));
    });
  });

  // ── chunk-order invariant ───────────────────────────────────────────

  describe('chunk-order invariant', () => {
    it('produces same result regardless of heritage record order', () => {
      ctx.model.symbols.add('src/d.ts', 'D', 'class:D', 'Class');
      ctx.model.symbols.add('src/c.ts', 'C', 'class:C', 'Class');
      ctx.model.symbols.add('src/b.ts', 'B', 'class:B', 'Class');
      ctx.model.symbols.add('src/a.ts', 'A', 'class:A', 'Class');

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
