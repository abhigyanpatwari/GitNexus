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

    it('allows duplicate adds for same file and name (overloads preserved)', () => {
      table.add('src/a.ts', 'foo', 'func:foo:1', 'Function');
      table.add('src/a.ts', 'foo', 'func:foo:2', 'Function');
      // File index stores both overloads; lookupExact returns first
      expect(table.lookupExact('src/a.ts', 'foo')).toBe('func:foo:1');
      // lookupExactAll returns all overloads
      expect(table.lookupExactAll('src/a.ts', 'foo')).toHaveLength(2);
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
      expect(results[0]).toEqual({
        nodeId: 'func:a:render',
        filePath: 'src/a.ts',
        type: 'Function',
      });
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
      table.add('src/utils.ts', 'getUser', 'func:getUser', 'Function', {
        returnType: 'Promise<User>',
      });
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

  describe('declaredType metadata', () => {
    it('stores declaredType in SymbolDefinition', () => {
      table.add('src/models.ts', 'address', 'prop:address', 'Property', {
        declaredType: 'Address',
        ownerId: 'class:User',
      });
      const def = table.lookupExactFull('src/models.ts', 'address');
      expect(def).toBeDefined();
      expect(def!.declaredType).toBe('Address');
    });

    it('omits declaredType when not provided', () => {
      table.add('src/models.ts', 'name', 'prop:name', 'Property', { ownerId: 'class:User' });
      const def = table.lookupExactFull('src/models.ts', 'name');
      expect(def).toBeDefined();
      expect(def!.declaredType).toBeUndefined();
    });
  });

  describe('Property exclusion from globalIndex', () => {
    it('Property with ownerId is NOT added to globalIndex', () => {
      table.add('src/models.ts', 'name', 'prop:name', 'Property', {
        declaredType: 'string',
        ownerId: 'class:User',
      });
      // Should not appear in fuzzy lookup
      expect(table.lookupFuzzy('name')).toEqual([]);
      // But should still be in fileIndex
      expect(table.lookupExact('src/models.ts', 'name')).toBe('prop:name');
    });

    it('Property without ownerId IS added to globalIndex', () => {
      table.add('src/models.ts', 'name', 'prop:name', 'Property');
      expect(table.lookupFuzzy('name')).toHaveLength(1);
    });

    it('Property without declaredType is still added to fieldByOwner index only (not globalIndex)', () => {
      table.add('src/models.ts', 'name', 'prop:name', 'Property', { ownerId: 'class:User' });
      // No declaredType → still indexed in fieldByOwner (for write-access tracking
      // in dynamically-typed languages like Ruby/JS), but excluded from globalIndex
      expect(table.lookupFuzzy('name')).toEqual([]);
      expect(table.lookupFieldByOwner('class:User', 'name')).toEqual({
        nodeId: 'prop:name',
        filePath: 'src/models.ts',
        type: 'Property',
        ownerId: 'class:User',
      });
    });

    it('non-Property types are always added to globalIndex', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', { ownerId: 'class:User' });
      expect(table.lookupFuzzy('save')).toHaveLength(1);
    });
  });

  describe('conditional callableIndex invalidation', () => {
    it('adding a Function invalidates callableIndex', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function', { returnType: 'void' });
      // First call builds the index
      expect(table.lookupFuzzyCallable('foo')).toHaveLength(1);
      // Add another callable — should invalidate and rebuild
      table.add('src/a.ts', 'bar', 'func:bar', 'Method');
      expect(table.lookupFuzzyCallable('bar')).toHaveLength(1);
    });

    it('adding a Property does NOT invalidate callableIndex', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      // Build callable index
      expect(table.lookupFuzzyCallable('foo')).toHaveLength(1);
      // Add a Property — callable index should still be valid (foo still found)
      table.add('src/models.ts', 'name', 'prop:name', 'Property', {
        declaredType: 'string',
        ownerId: 'class:User',
      });
      expect(table.lookupFuzzyCallable('foo')).toHaveLength(1);
    });

    it('adding a Class does NOT invalidate callableIndex', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      expect(table.lookupFuzzyCallable('foo')).toHaveLength(1);
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      // Class is not callable, should not trigger rebuild
      expect(table.lookupFuzzyCallable('foo')).toHaveLength(1);
    });
  });

  describe('lookupFieldByOwner', () => {
    it('finds a Property by ownerNodeId and fieldName', () => {
      table.add('src/models.ts', 'address', 'prop:address', 'Property', {
        declaredType: 'Address',
        ownerId: 'class:User',
      });
      const def = table.lookupFieldByOwner('class:User', 'address');
      expect(def).toBeDefined();
      expect(def!.declaredType).toBe('Address');
      expect(def!.nodeId).toBe('prop:address');
    });

    it('returns undefined for unknown owner', () => {
      table.add('src/models.ts', 'address', 'prop:address', 'Property', {
        declaredType: 'Address',
        ownerId: 'class:User',
      });
      expect(table.lookupFieldByOwner('class:Unknown', 'address')).toBeUndefined();
    });

    it('returns undefined for unknown field name', () => {
      table.add('src/models.ts', 'address', 'prop:address', 'Property', {
        declaredType: 'Address',
        ownerId: 'class:User',
      });
      expect(table.lookupFieldByOwner('class:User', 'email')).toBeUndefined();
    });

    it('returns undefined for empty table', () => {
      expect(table.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
    });

    it('indexes Property without declaredType (for dynamic language write-access)', () => {
      table.add('src/models.ts', 'name', 'prop:name', 'Property', { ownerId: 'class:User' });
      expect(table.lookupFieldByOwner('class:User', 'name')).toEqual({
        nodeId: 'prop:name',
        filePath: 'src/models.ts',
        type: 'Property',
        ownerId: 'class:User',
      });
    });

    it('distinguishes fields by owner', () => {
      table.add('src/models.ts', 'name', 'prop:user:name', 'Property', {
        declaredType: 'string',
        ownerId: 'class:User',
      });
      table.add('src/models.ts', 'name', 'prop:repo:name', 'Property', {
        declaredType: 'RepoName',
        ownerId: 'class:Repo',
      });
      expect(table.lookupFieldByOwner('class:User', 'name')!.declaredType).toBe('string');
      expect(table.lookupFieldByOwner('class:Repo', 'name')!.declaredType).toBe('RepoName');
    });
  });

  describe('lookupFuzzyCallable', () => {
    it('returns only callable types (Function, Method, Constructor)', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      table.add('src/a.ts', 'bar', 'method:bar', 'Method');
      table.add('src/a.ts', 'Baz', 'ctor:Baz', 'Constructor');
      table.add('src/a.ts', 'User', 'class:User', 'Class');
      table.add('src/a.ts', 'IUser', 'iface:IUser', 'Interface');
      expect(table.lookupFuzzyCallable('foo')).toHaveLength(1);
      expect(table.lookupFuzzyCallable('bar')).toHaveLength(1);
      expect(table.lookupFuzzyCallable('Baz')).toHaveLength(1);
      expect(table.lookupFuzzyCallable('User')).toEqual([]);
      expect(table.lookupFuzzyCallable('IUser')).toEqual([]);
    });

    it('returns empty array for unknown name', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      expect(table.lookupFuzzyCallable('unknown')).toEqual([]);
    });

    it('rebuilds index after adding new callable', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      expect(table.lookupFuzzyCallable('foo')).toHaveLength(1);
      expect(table.lookupFuzzyCallable('bar')).toEqual([]);
      table.add('src/a.ts', 'bar', 'func:bar', 'Function');
      expect(table.lookupFuzzyCallable('bar')).toHaveLength(1);
    });

    it('filters non-callable types from mixed name entries', () => {
      table.add('src/a.ts', 'save', 'func:save', 'Function');
      table.add('src/b.ts', 'save', 'class:save', 'Class');
      const callables = table.lookupFuzzyCallable('save');
      expect(callables).toHaveLength(1);
      expect(callables[0].type).toBe('Function');
    });
  });

  describe('clear', () => {
    it('resets all state including fieldByOwner', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      table.add('src/b.ts', 'bar', 'func:bar', 'Function');
      table.add('src/models.ts', 'address', 'prop:address', 'Property', {
        declaredType: 'Address',
        ownerId: 'class:User',
      });
      table.clear();
      expect(table.getStats()).toEqual({ fileCount: 0, globalSymbolCount: 0 });
      expect(table.lookupExact('src/a.ts', 'foo')).toBeUndefined();
      expect(table.lookupFuzzy('foo')).toEqual([]);
      expect(table.lookupFieldByOwner('class:User', 'address')).toBeUndefined();
      expect(table.lookupFuzzyCallable('foo')).toEqual([]);
    });

    it('allows re-adding after clear', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      table.clear();
      table.add('src/b.ts', 'bar', 'func:bar', 'Function');
      expect(table.getStats()).toEqual({ fileCount: 1, globalSymbolCount: 1 });
    });

    it('resets callableIndex so first lookup after clear rebuilds from scratch', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      // Populate the lazy callable index
      expect(table.lookupFuzzyCallable('foo')).toHaveLength(1);
      table.clear();
      // After clear the callable index must be gone — empty table returns nothing
      expect(table.lookupFuzzyCallable('foo')).toEqual([]);
      // Re-adding and looking up rebuilds successfully
      table.add('src/a.ts', 'foo', 'func:foo2', 'Function');
      expect(table.lookupFuzzyCallable('foo')).toHaveLength(1);
      expect(table.lookupFuzzyCallable('foo')[0].nodeId).toBe('func:foo2');
    });
  });

  describe('metadata spread branches (individual optional fields)', () => {
    it('stores only parameterCount when no other metadata is given', () => {
      table.add('src/utils.ts', 'compute', 'func:compute', 'Function', { parameterCount: 3 });
      const def = table.lookupExactFull('src/utils.ts', 'compute');
      expect(def).toBeDefined();
      expect(def!.parameterCount).toBe(3);
      expect(def!.returnType).toBeUndefined();
      expect(def!.declaredType).toBeUndefined();
      expect(def!.ownerId).toBeUndefined();
    });

    it('stores only ownerId on a Method (non-Property) — still added to globalIndex', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', { ownerId: 'class:Repo' });
      const def = table.lookupExactFull('src/models.ts', 'save');
      expect(def).toBeDefined();
      expect(def!.ownerId).toBe('class:Repo');
      expect(def!.parameterCount).toBeUndefined();
      expect(def!.returnType).toBeUndefined();
      expect(def!.declaredType).toBeUndefined();
      // Non-Property with ownerId must still appear in globalIndex
      expect(table.lookupFuzzy('save')).toHaveLength(1);
    });

    it('stores declaredType alone (no ownerId) — symbol goes to globalIndex', () => {
      // A Variable/Property without an owner should still be globally visible
      table.add('src/config.ts', 'DEFAULT_TIMEOUT', 'var:DEFAULT_TIMEOUT', 'Variable', {
        declaredType: 'number',
      });
      const def = table.lookupExactFull('src/config.ts', 'DEFAULT_TIMEOUT');
      expect(def).toBeDefined();
      expect(def!.declaredType).toBe('number');
      expect(def!.ownerId).toBeUndefined();
      // No ownerId → not a Property exclusion path → must be in globalIndex
      expect(table.lookupFuzzy('DEFAULT_TIMEOUT')).toHaveLength(1);
      expect(table.lookupFuzzy('DEFAULT_TIMEOUT')[0].declaredType).toBe('number');
    });

    it('stores all four optional metadata fields simultaneously on a Method', () => {
      table.add('src/models.ts', 'find', 'method:find', 'Method', {
        parameterCount: 2,
        returnType: 'User | undefined',
        declaredType: 'QueryResult',
        ownerId: 'class:UserRepository',
      });
      const def = table.lookupExactFull('src/models.ts', 'find');
      expect(def).toBeDefined();
      expect(def!.parameterCount).toBe(2);
      expect(def!.returnType).toBe('User | undefined');
      expect(def!.declaredType).toBe('QueryResult');
      expect(def!.ownerId).toBe('class:UserRepository');
    });

    it('omits all optional fields when metadata is not provided at all', () => {
      table.add('src/utils.ts', 'noop', 'func:noop', 'Function');
      const def = table.lookupExactFull('src/utils.ts', 'noop');
      expect(def).toBeDefined();
      expect(def!.parameterCount).toBeUndefined();
      expect(def!.returnType).toBeUndefined();
      expect(def!.declaredType).toBeUndefined();
      expect(def!.ownerId).toBeUndefined();
    });

    it('stores parameterCount: 0 (falsy value) correctly', () => {
      // parameterCount of 0 must not be dropped by the spread guard
      table.add('src/utils.ts', 'noArgs', 'func:noArgs', 'Function', { parameterCount: 0 });
      const def = table.lookupExactFull('src/utils.ts', 'noArgs');
      expect(def).toBeDefined();
      expect(def!.parameterCount).toBe(0);
    });
  });

  describe('lookupFuzzyCallable — lazy index behaviour', () => {
    it('returns empty array when table has no callables', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      table.add('src/models.ts', 'IUser', 'iface:IUser', 'Interface');
      expect(table.lookupFuzzyCallable('User')).toEqual([]);
      expect(table.lookupFuzzyCallable('IUser')).toEqual([]);
    });

    it('uses cached index on second call without adding new symbols', () => {
      table.add('src/a.ts', 'fetch', 'func:fetch', 'Function', { returnType: 'Response' });
      // First call — builds the lazy index
      const first = table.lookupFuzzyCallable('fetch');
      expect(first).toHaveLength(1);
      // Second call — must return equivalent result from cache
      const second = table.lookupFuzzyCallable('fetch');
      expect(second).toHaveLength(1);
      expect(second[0].nodeId).toBe('func:fetch');
      // Both calls return the same array reference (same cache entry)
      expect(first).toBe(second);
    });

    it('invalidated cache is rebuilt correctly after adding a Method', () => {
      table.add('src/a.ts', 'alpha', 'func:alpha', 'Function');
      // Warm the cache
      expect(table.lookupFuzzyCallable('alpha')).toHaveLength(1);
      expect(table.lookupFuzzyCallable('beta')).toEqual([]);
      // Add a Method — must invalidate cache
      table.add('src/a.ts', 'beta', 'method:beta', 'Method');
      // Rebuilt cache must now include beta
      const result = table.lookupFuzzyCallable('beta');
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('Method');
    });

    it('invalidated cache is rebuilt correctly after adding a Constructor', () => {
      table.add('src/a.ts', 'existing', 'func:existing', 'Function');
      expect(table.lookupFuzzyCallable('existing')).toHaveLength(1);
      table.add('src/models.ts', 'MyClass', 'ctor:MyClass', 'Constructor');
      expect(table.lookupFuzzyCallable('MyClass')).toHaveLength(1);
      expect(table.lookupFuzzyCallable('MyClass')[0].type).toBe('Constructor');
    });
  });

  describe('lookupExactFull — full SymbolDefinition shape', () => {
    it('returns undefined for unknown file', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      expect(table.lookupExactFull('src/other.ts', 'foo')).toBeUndefined();
    });

    it('returns undefined for unknown symbol name within a known file', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      expect(table.lookupExactFull('src/a.ts', 'bar')).toBeUndefined();
    });

    it('returns undefined for empty table', () => {
      expect(table.lookupExactFull('src/a.ts', 'foo')).toBeUndefined();
    });

    it('returns the full SymbolDefinition including nodeId, filePath, and type', () => {
      table.add('src/models.ts', 'address', 'prop:address', 'Property', {
        declaredType: 'Address',
        ownerId: 'class:User',
      });
      const def = table.lookupExactFull('src/models.ts', 'address');
      expect(def).toBeDefined();
      expect(def!.nodeId).toBe('prop:address');
      expect(def!.filePath).toBe('src/models.ts');
      expect(def!.type).toBe('Property');
      expect(def!.declaredType).toBe('Address');
      expect(def!.ownerId).toBe('class:User');
    });

    it('returns first definition when same file and name are added twice (overloads preserved)', () => {
      table.add('src/a.ts', 'foo', 'func:foo:v1', 'Function', { returnType: 'void' });
      table.add('src/a.ts', 'foo', 'func:foo:v2', 'Function', { returnType: 'string' });
      // lookupExactFull returns first match
      const def = table.lookupExactFull('src/a.ts', 'foo');
      expect(def).toBeDefined();
      expect(def!.nodeId).toBe('func:foo:v1');
      expect(def!.returnType).toBe('void');
      // lookupExactAll returns all overloads
      const all = table.lookupExactAll('src/a.ts', 'foo');
      expect(all).toHaveLength(2);
      expect(all[0].nodeId).toBe('func:foo:v1');
      expect(all[1].nodeId).toBe('func:foo:v2');
      expect(all[1].returnType).toBe('string');
    });
  });

  describe('lookupFieldByOwner — additional coverage', () => {
    it('stores multiple distinct fields under the same owner', () => {
      table.add('src/models.ts', 'id', 'prop:user:id', 'Property', {
        declaredType: 'number',
        ownerId: 'class:User',
      });
      table.add('src/models.ts', 'email', 'prop:user:email', 'Property', {
        declaredType: 'string',
        ownerId: 'class:User',
      });
      table.add('src/models.ts', 'createdAt', 'prop:user:createdAt', 'Property', {
        declaredType: 'Date',
        ownerId: 'class:User',
      });
      expect(table.lookupFieldByOwner('class:User', 'id')!.declaredType).toBe('number');
      expect(table.lookupFieldByOwner('class:User', 'email')!.declaredType).toBe('string');
      expect(table.lookupFieldByOwner('class:User', 'createdAt')!.declaredType).toBe('Date');
    });

    it('returns the full SymbolDefinition (nodeId + filePath + type) not just declaredType', () => {
      table.add('src/models.ts', 'score', 'prop:score', 'Property', {
        declaredType: 'number',
        ownerId: 'class:Player',
      });
      const def = table.lookupFieldByOwner('class:Player', 'score');
      expect(def).toBeDefined();
      expect(def!.nodeId).toBe('prop:score');
      expect(def!.filePath).toBe('src/models.ts');
      expect(def!.type).toBe('Property');
    });

    it('key collision is impossible between different owners sharing a field name', () => {
      // Ensures the null-byte separator in the key prevents cross-owner leakage
      table.add('src/models.ts', 'id', 'prop:a:id', 'Property', {
        declaredType: 'string',
        ownerId: 'class:A',
      });
      table.add('src/models.ts', 'id', 'prop:b:id', 'Property', {
        declaredType: 'UUID',
        ownerId: 'class:B',
      });
      expect(table.lookupFieldByOwner('class:A', 'id')!.nodeId).toBe('prop:a:id');
      expect(table.lookupFieldByOwner('class:B', 'id')!.nodeId).toBe('prop:b:id');
      // An owner whose id is the concatenation of A's ownerId + fieldName must not match
      expect(table.lookupFieldByOwner('class:A\0id', '')).toBeUndefined();
    });
  });
});
