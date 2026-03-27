import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  PARSE_CACHE_VERSION,
  contentHash,
  createEmptyCache,
  loadParseCache,
  saveParseCache,
  deleteParseCache,
  pruneCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';

describe('parse-cache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-parse-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('contentHash', () => {
    it('is deterministic', () => {
      expect(contentHash('hello')).toBe(contentHash('hello'));
    });

    it('differs for different content', () => {
      expect(contentHash('hello')).not.toBe(contentHash('world'));
    });

    it('returns a 64-char hex string (SHA-256)', () => {
      const hash = contentHash('test');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('createEmptyCache', () => {
    it('has correct version', () => {
      const cache = createEmptyCache();
      expect(cache.version).toBe(PARSE_CACHE_VERSION);
    });

    it('has empty entries', () => {
      const cache = createEmptyCache();
      expect(Object.keys(cache.entries)).toHaveLength(0);
    });
  });

  describe('loadParseCache', () => {
    it('returns empty cache when file missing', async () => {
      const cache = await loadParseCache(tmpDir);
      expect(cache.version).toBe(PARSE_CACHE_VERSION);
      expect(Object.keys(cache.entries)).toHaveLength(0);
    });

    it('returns empty cache when JSON is corrupt', async () => {
      await fs.writeFile(path.join(tmpDir, 'parse-cache.json'), '{invalid', 'utf-8');
      const cache = await loadParseCache(tmpDir);
      expect(Object.keys(cache.entries)).toHaveLength(0);
    });

    it('returns empty cache when version mismatches', async () => {
      const stale = { version: -1, entries: { 'foo.ts': { hash: 'abc', result: {} } } };
      await fs.writeFile(path.join(tmpDir, 'parse-cache.json'), JSON.stringify(stale), 'utf-8');
      const cache = await loadParseCache(tmpDir);
      expect(Object.keys(cache.entries)).toHaveLength(0);
    });

    it('loads valid cache', async () => {
      const valid: ParseCache = { version: PARSE_CACHE_VERSION, entries: { 'foo.ts': { hash: 'abc', result: minimalResult() } } };
      await fs.writeFile(path.join(tmpDir, 'parse-cache.json'), JSON.stringify(valid), 'utf-8');
      const cache = await loadParseCache(tmpDir);
      expect(cache.entries['foo.ts'].hash).toBe('abc');
    });
  });

  describe('saveParseCache', () => {
    it('writes and loads back correctly', async () => {
      const cache: ParseCache = { version: PARSE_CACHE_VERSION, entries: { 'bar.rs': { hash: 'xyz', result: minimalResult() } } };
      await saveParseCache(tmpDir, cache);
      const loaded = await loadParseCache(tmpDir);
      expect(loaded.entries['bar.rs'].hash).toBe('xyz');
    });

    it('creates directory if missing', async () => {
      const nested = path.join(tmpDir, 'sub', 'dir');
      const cache = createEmptyCache();
      await saveParseCache(nested, cache);
      const loaded = await loadParseCache(nested);
      expect(loaded.version).toBe(PARSE_CACHE_VERSION);
    });

    it('no temp file left behind', async () => {
      await saveParseCache(tmpDir, createEmptyCache());
      const files = await fs.readdir(tmpDir);
      expect(files).not.toContain('parse-cache.json.tmp');
      expect(files).toContain('parse-cache.json');
    });
  });

  describe('deleteParseCache', () => {
    it('removes cache file', async () => {
      await saveParseCache(tmpDir, createEmptyCache());
      await deleteParseCache(tmpDir);
      const files = await fs.readdir(tmpDir);
      expect(files).not.toContain('parse-cache.json');
    });

    it('does not throw if file missing', async () => {
      await expect(deleteParseCache(tmpDir)).resolves.toBeUndefined();
    });
  });

  describe('pruneCache', () => {
    it('removes entries for deleted files', () => {
      const cache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: {
          'a.ts': { hash: '1', result: minimalResult() },
          'b.ts': { hash: '2', result: minimalResult() },
          'c.ts': { hash: '3', result: minimalResult() },
        },
      };
      const removed = pruneCache(cache, new Set(['a.ts', 'c.ts']));
      expect(removed).toBe(1);
      expect(cache.entries['a.ts']).toBeDefined();
      expect(cache.entries['b.ts']).toBeUndefined();
      expect(cache.entries['c.ts']).toBeDefined();
    });

    it('preserves all entries when all files exist', () => {
      const cache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: { 'x.ts': { hash: 'h', result: minimalResult() } },
      };
      const removed = pruneCache(cache, new Set(['x.ts']));
      expect(removed).toBe(0);
      expect(cache.entries['x.ts']).toBeDefined();
    });

    it('removes all entries when no files match', () => {
      const cache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: { 'old.ts': { hash: 'h', result: minimalResult() } },
      };
      const removed = pruneCache(cache, new Set([]));
      expect(removed).toBe(1);
      expect(Object.keys(cache.entries)).toHaveLength(0);
    });
  });
});

function minimalResult(): any {
  return {
    nodes: [], relationships: [], symbols: [],
    imports: [], calls: [], assignments: [], heritage: [],
    routes: [], fetchCalls: [], decoratorRoutes: [], toolDefs: [],
    ormQueries: [], constructorBindings: [], typeEnvBindings: [],
    skippedLanguages: {}, fileCount: 0,
  };
}
