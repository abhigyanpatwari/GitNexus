import { describe, it, expect } from 'vitest';
import {
  extractObjectLiteralKeys,
  extractDestructuredKeys,
  extractPropertyAccessKeys,
  cacheKeyPrefix,
  cacheKeysOverlap,
} from '../../src/core/ingestion/shape-inference.js';

describe('shape-inference', () => {
  describe('extractObjectLiteralKeys', () => {
    it('extracts top-level keys from JSON return', () => {
      const code = `return Response.json({ patterns, total, page })`;
      expect(extractObjectLiteralKeys(code)).toEqual(['patterns', 'total', 'page']);
    });

    it('extracts keys from NextResponse.json', () => {
      const code = `return NextResponse.json({ data: items, pagination: { page, limit } })`;
      expect(extractObjectLiteralKeys(code)).toEqual(['data', 'pagination']);
    });

    it('returns empty for no object literal', () => {
      expect(extractObjectLiteralKeys(`return data`)).toEqual([]);
    });
  });

  describe('extractDestructuredKeys', () => {
    it('extracts destructured keys from data variable', () => {
      const code = `const { patterns, total } = data;`;
      expect(extractDestructuredKeys(code)).toEqual(['patterns', 'total']);
    });

    it('extracts from response.json() destructuring', () => {
      const code = `const { items, count } = await res.json();`;
      expect(extractDestructuredKeys(code)).toEqual(['items', 'count']);
    });

    it('extracts from nested destructuring (top level only)', () => {
      const code = `const { data: { items }, total } = response;`;
      expect(extractDestructuredKeys(code)).toContain('total');
    });
  });

  describe('extractPropertyAccessKeys', () => {
    it('extracts dot-access keys on data variable', () => {
      const code = `console.log(data.patterns);\nconst x = data.total;`;
      expect(extractPropertyAccessKeys(code)).toEqual(expect.arrayContaining(['patterns', 'total']));
    });

    it('extracts optional chaining keys', () => {
      const code = `data?.items?.length`;
      expect(extractPropertyAccessKeys(code)).toContain('items');
    });

    it('filters out method-like accesses', () => {
      const keys = extractPropertyAccessKeys(`data.toString(); data.length; data.items`);
      expect(keys).not.toContain('toString');
      expect(keys).not.toContain('length');
      expect(keys).toContain('items');
    });
  });

  describe('cacheKeyPrefix', () => {
    it('extracts static prefix from array key', () => {
      expect(cacheKeyPrefix(`['vendor-patterns', slug]`)).toBe('vendor-patterns');
    });

    it('extracts prefix from single-string key', () => {
      expect(cacheKeyPrefix(`'vendor-patterns'`)).toBe('vendor-patterns');
    });

    it('extracts prefix from template literal', () => {
      expect(cacheKeyPrefix('`/api/vendors/${id}`')).toBe('/api/vendors/');
    });
  });

  describe('cacheKeysOverlap', () => {
    it('detects exact match', () => {
      expect(cacheKeysOverlap(`['vendor-patterns', slug]`, `['vendor-patterns', slug]`)).toBe(true);
    });

    it('detects prefix match with different dynamic parts', () => {
      expect(cacheKeysOverlap(`['vendor-patterns', slug]`, `['vendor-patterns', id]`)).toBe(true);
    });

    it('rejects different prefixes', () => {
      expect(cacheKeysOverlap(`['vendor-patterns']`, `['grants']`)).toBe(false);
    });
  });
});
