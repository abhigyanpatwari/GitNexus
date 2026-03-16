import { describe, it, expect, beforeEach } from 'vitest';
import { createASTCache, type ASTCache } from '../../src/core/ingestion/ast-cache.js';

// Create a minimal mock tree object (mimics Parser.Tree interface)
function mockTree(id: string): any {
  return { rootNode: { type: 'program', text: id }, delete: vi.fn() };
}

describe('ASTCache', () => {
  let cache: ASTCache;

  beforeEach(() => {
    cache = createASTCache(3);
  });

  describe('get / set', () => {
    it('returns undefined for cache miss', () => {
      expect(cache.get('nonexistent.ts')).toBeUndefined();
    });

    it('returns cached tree on hit', () => {
      const tree = mockTree('test');
      cache.set('src/index.ts', tree);
      expect(cache.get('src/index.ts')).toBe(tree);
    });

    it('overwrites existing entry for same key', () => {
      const tree1 = mockTree('v1');
      const tree2 = mockTree('v2');
      cache.set('src/index.ts', tree1);
      cache.set('src/index.ts', tree2);
      expect(cache.get('src/index.ts')).toBe(tree2);
    });
  });

  describe('LRU eviction', () => {
    it('evicts least recently used when capacity exceeded', () => {
      cache.set('a.ts', mockTree('a'));
      cache.set('b.ts', mockTree('b'));
      cache.set('c.ts', mockTree('c'));
      // Cache is full (maxSize=3). Adding one more evicts 'a'
      cache.set('d.ts', mockTree('d'));
      expect(cache.get('a.ts')).toBeUndefined();
      expect(cache.get('b.ts')).toBeDefined();
      expect(cache.get('d.ts')).toBeDefined();
    });

    it('accessing an entry makes it recently used', () => {
      cache.set('a.ts', mockTree('a'));
      cache.set('b.ts', mockTree('b'));
      cache.set('c.ts', mockTree('c'));
      // Touch 'a' to make it recently used
      cache.get('a.ts');
      // Now 'b' is LRU
      cache.set('d.ts', mockTree('d'));
      expect(cache.get('a.ts')).toBeDefined();
      expect(cache.get('b.ts')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      cache.set('a.ts', mockTree('a'));
      cache.set('b.ts', mockTree('b'));
      cache.clear();
      expect(cache.get('a.ts')).toBeUndefined();
      expect(cache.get('b.ts')).toBeUndefined();
      expect(cache.stats().size).toBe(0);
    });
  });

  describe('stats', () => {
    it('reports size and maxSize', () => {
      expect(cache.stats()).toEqual({ size: 0, maxSize: 3 });
      cache.set('a.ts', mockTree('a'));
      expect(cache.stats()).toEqual({ size: 1, maxSize: 3 });
      cache.set('b.ts', mockTree('b'));
      expect(cache.stats()).toEqual({ size: 2, maxSize: 3 });
    });

    it('uses default maxSize of 50', () => {
      const defaultCache = createASTCache();
      expect(defaultCache.stats().maxSize).toBe(50);
    });

    it('clamps maxSize of 0 to 1 to prevent LRU cache error', () => {
      const zeroCache = createASTCache(0);
      expect(zeroCache.stats().maxSize).toBe(1);
      // Should still function correctly
      const tree = mockTree('test');
      zeroCache.set('a.ts', tree);
      expect(zeroCache.get('a.ts')).toBe(tree);
    });
  });
});
