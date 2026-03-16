import { describe, it, expect, beforeEach } from 'vitest';
import { createSymbolTable, type SymbolTable } from '../../src/core/ingestion/symbol-table.js';

describe('SymbolTable', () => {
  let table: SymbolTable;

  beforeEach(() => {
    table = createSymbolTable();
  });

  describe('add', () => {
    it('registers a symbol in the table', () => {
      table.add('src/index.ts', 'main', 'func:main', 'Function');
      expect(table.getStats().globalSymbolCount).toBe(1);
      expect(table.getStats().fileCount).toBe(1);
    });

    it('handles multiple symbols in the same file', () => {
      table.add('src/index.ts', 'main', 'func:main', 'Function');
      table.add('src/index.ts', 'helper', 'func:helper', 'Function');
      expect(table.getStats().fileCount).toBe(1);
      expect(table.getStats().globalSymbolCount).toBe(2);
    });

    it('handles same name in different files', () => {
      table.add('src/a.ts', 'init', 'func:a:init', 'Function');
      table.add('src/b.ts', 'init', 'func:b:init', 'Function');
      expect(table.getStats().fileCount).toBe(2);
      // Global index groups by name, so 'init' has one entry with two definitions
      expect(table.getStats().globalSymbolCount).toBe(1);
    });

    it('allows duplicate adds for same file and name', () => {
      table.add('src/a.ts', 'foo', 'func:foo:1', 'Function');
      table.add('src/a.ts', 'foo', 'func:foo:2', 'Function');
      // File index overwrites: last wins
      expect(table.lookupExact('src/a.ts', 'foo')).toBe('func:foo:2');
      // Global index appends
      expect(table.lookupFuzzy('foo')).toHaveLength(2);
    });
  });

  describe('lookupExact', () => {
    it('finds a symbol by file path and name', () => {
      table.add('src/index.ts', 'main', 'func:main', 'Function');
      expect(table.lookupExact('src/index.ts', 'main')).toBe('func:main');
    });

    it('returns undefined for unknown file', () => {
      table.add('src/index.ts', 'main', 'func:main', 'Function');
      expect(table.lookupExact('src/other.ts', 'main')).toBeUndefined();
    });

    it('returns undefined for unknown symbol name', () => {
      table.add('src/index.ts', 'main', 'func:main', 'Function');
      expect(table.lookupExact('src/index.ts', 'notExist')).toBeUndefined();
    });

    it('returns undefined for empty table', () => {
      expect(table.lookupExact('src/index.ts', 'main')).toBeUndefined();
    });
  });

  describe('lookupFuzzy', () => {
    it('finds all definitions of a symbol across files', () => {
      table.add('src/a.ts', 'render', 'func:a:render', 'Function');
      table.add('src/b.ts', 'render', 'func:b:render', 'Method');
      const results = table.lookupFuzzy('render');
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ nodeId: 'func:a:render', filePath: 'src/a.ts', type: 'Function' });
      expect(results[1]).toEqual({ nodeId: 'func:b:render', filePath: 'src/b.ts', type: 'Method' });
    });

    it('returns empty array for unknown symbol', () => {
      expect(table.lookupFuzzy('nonexistent')).toEqual([]);
    });

    it('returns empty array for empty table', () => {
      expect(table.lookupFuzzy('anything')).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('returns zero counts for empty table', () => {
      expect(table.getStats()).toEqual({ fileCount: 0, globalSymbolCount: 0 });
    });

    it('tracks unique file count correctly', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      table.add('src/a.ts', 'bar', 'func:bar', 'Function');
      table.add('src/b.ts', 'baz', 'func:baz', 'Function');
      expect(table.getStats().fileCount).toBe(2);
    });

    it('tracks unique global symbol names', () => {
      table.add('src/a.ts', 'foo', 'func:a:foo', 'Function');
      table.add('src/b.ts', 'foo', 'func:b:foo', 'Function');
      table.add('src/a.ts', 'bar', 'func:a:bar', 'Function');
      // 'foo' and 'bar' are 2 unique global names
      expect(table.getStats().globalSymbolCount).toBe(2);
    });
  });

  describe('returnType metadata', () => {
    it('stores returnType in SymbolDefinition', () => {
      table.add('src/utils.ts', 'getUser', 'func:getUser', 'Function', { returnType: 'User' });
      const def = table.lookupExactFull('src/utils.ts', 'getUser');
      expect(def).toBeDefined();
      expect(def!.returnType).toBe('User');
    });

    it('returnType is available via lookupFuzzy', () => {
      table.add('src/utils.ts', 'getUser', 'func:getUser', 'Function', { returnType: 'Promise<User>' });
      const results = table.lookupFuzzy('getUser');
      expect(results).toHaveLength(1);
      expect(results[0].returnType).toBe('Promise<User>');
    });

    it('omits returnType when not provided', () => {
      table.add('src/utils.ts', 'helper', 'func:helper', 'Function');
      const def = table.lookupExactFull('src/utils.ts', 'helper');
      expect(def).toBeDefined();
      expect(def!.returnType).toBeUndefined();
    });

    it('stores returnType alongside parameterCount and ownerId', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', {
        parameterCount: 1,
        returnType: 'boolean',
        ownerId: 'class:User',
      });
      const def = table.lookupExactFull('src/models.ts', 'save');
      expect(def).toBeDefined();
      expect(def!.parameterCount).toBe(1);
      expect(def!.returnType).toBe('boolean');
      expect(def!.ownerId).toBe('class:User');
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      table.add('src/b.ts', 'bar', 'func:bar', 'Function');
      table.clear();
      expect(table.getStats()).toEqual({ fileCount: 0, globalSymbolCount: 0 });
      expect(table.lookupExact('src/a.ts', 'foo')).toBeUndefined();
      expect(table.lookupFuzzy('foo')).toEqual([]);
    });

    it('allows re-adding after clear', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      table.clear();
      table.add('src/b.ts', 'bar', 'func:bar', 'Function');
      expect(table.getStats()).toEqual({ fileCount: 1, globalSymbolCount: 1 });
    });
  });
});
