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
      expect(table.getStats()).toEqual({
        fileCount: 0,
        globalSymbolCount: 0,
        fuzzyCallCount: 0,
        fuzzyCallableCallCount: 0,
      });
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

  describe('lookupMethodByOwner', () => {
    it('finds a Method by ownerNodeId and method name', () => {
      table.add('src/models.ts', 'getAddress', 'method:getAddress', 'Method', {
        returnType: 'Address',
        ownerId: 'class:User',
      });
      const def = table.lookupMethodByOwner('class:User', 'getAddress');
      expect(def).toBeDefined();
      expect(def!.returnType).toBe('Address');
      expect(def!.nodeId).toBe('method:getAddress');
    });

    it('finds multiple methods on the same owner', () => {
      table.add('src/models.ts', 'getAddress', 'method:getAddress', 'Method', {
        returnType: 'Address',
        ownerId: 'class:User',
      });
      table.add('src/models.ts', 'getName', 'method:getName', 'Method', {
        returnType: 'String',
        ownerId: 'class:User',
      });
      expect(table.lookupMethodByOwner('class:User', 'getAddress')!.returnType).toBe('Address');
      expect(table.lookupMethodByOwner('class:User', 'getName')!.returnType).toBe('String');
    });

    it('distinguishes methods by owner', () => {
      table.add('src/models.ts', 'save', 'method:user:save', 'Method', {
        returnType: 'boolean',
        ownerId: 'class:User',
      });
      table.add('src/models.ts', 'save', 'method:address:save', 'Method', {
        returnType: 'void',
        ownerId: 'class:Address',
      });
      expect(table.lookupMethodByOwner('class:User', 'save')!.nodeId).toBe('method:user:save');
      expect(table.lookupMethodByOwner('class:Address', 'save')!.nodeId).toBe(
        'method:address:save',
      );
    });

    it('returns undefined for unknown owner', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', {
        returnType: 'void',
        ownerId: 'class:User',
      });
      expect(table.lookupMethodByOwner('class:Unknown', 'save')).toBeUndefined();
    });

    it('returns undefined for unknown method name', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', {
        returnType: 'void',
        ownerId: 'class:User',
      });
      expect(table.lookupMethodByOwner('class:User', 'delete')).toBeUndefined();
    });

    it('returns undefined for empty table', () => {
      expect(table.lookupMethodByOwner('class:User', 'save')).toBeUndefined();
    });

    it('does NOT index Method without ownerId', () => {
      table.add('src/utils.ts', 'helper', 'method:helper', 'Method');
      expect(table.lookupMethodByOwner('', 'helper')).toBeUndefined();
      // But it should still be in lookupFuzzy
      expect(table.lookupFuzzy('helper')).toHaveLength(1);
    });

    it('returns first match for overloads with same returnType (unambiguous)', () => {
      table.add('src/models.ts', 'find', 'method:find:1', 'Method', {
        parameterCount: 1,
        returnType: 'User',
        ownerId: 'class:UserRepo',
      });
      table.add('src/models.ts', 'find', 'method:find:2', 'Method', {
        parameterCount: 2,
        returnType: 'User',
        ownerId: 'class:UserRepo',
      });
      const def = table.lookupMethodByOwner('class:UserRepo', 'find');
      expect(def).toBeDefined();
      expect(def!.nodeId).toBe('method:find:1');
      expect(def!.returnType).toBe('User');
    });

    it('returns undefined for overloads both missing returnType (ambiguous)', () => {
      table.add('src/models.ts', 'process', 'method:process:1', 'Method', {
        parameterCount: 1,
        ownerId: 'class:Handler',
      });
      table.add('src/models.ts', 'process', 'method:process:2', 'Method', {
        parameterCount: 2,
        ownerId: 'class:Handler',
      });
      expect(table.lookupMethodByOwner('class:Handler', 'process')).toBeUndefined();
    });

    it('indexes Constructor in methodByOwner', () => {
      table.add('src/models.ts', 'User', 'ctor:User', 'Constructor', {
        parameterCount: 0,
        ownerId: 'class:User',
      });
      expect(table.lookupMethodByOwner('class:User', 'User')).toEqual({
        nodeId: 'ctor:User',
        filePath: 'src/models.ts',
        type: 'Constructor',
        parameterCount: 0,
        ownerId: 'class:User',
      });
      // But it should be in lookupFuzzyCallable
      expect(table.lookupFuzzyCallable('User')).toHaveLength(1);
    });

    it('returns undefined for overloads with different returnTypes (ambiguous)', () => {
      table.add('src/models.ts', 'convert', 'method:convert:1', 'Method', {
        parameterCount: 1,
        returnType: 'String',
        ownerId: 'class:Converter',
      });
      table.add('src/models.ts', 'convert', 'method:convert:2', 'Method', {
        parameterCount: 2,
        returnType: 'Number',
        ownerId: 'class:Converter',
      });
      expect(table.lookupMethodByOwner('class:Converter', 'convert')).toBeUndefined();
    });

    it('Method with ownerId is still available via lookupFuzzy and lookupFuzzyCallable', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', {
        returnType: 'void',
        ownerId: 'class:User',
      });
      // Methods stay in globalIndex (unlike Properties)
      expect(table.lookupFuzzy('save')).toHaveLength(1);
      expect(table.lookupFuzzyCallable('save')).toHaveLength(1);
    });

    it('after clear(), lookupMethodByOwner returns undefined', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', {
        returnType: 'void',
        ownerId: 'class:User',
      });
      expect(table.lookupMethodByOwner('class:User', 'save')).toBeDefined();
      table.clear();
      expect(table.lookupMethodByOwner('class:User', 'save')).toBeUndefined();
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
    it('resets all state including fieldByOwner, methodByOwner, and classByName', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      table.add('src/b.ts', 'bar', 'func:bar', 'Function');
      table.add('src/models.ts', 'address', 'prop:address', 'Property', {
        declaredType: 'Address',
        ownerId: 'class:User',
      });
      table.add('src/models.ts', 'save', 'method:save', 'Method', {
        returnType: 'void',
        ownerId: 'class:User',
      });
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      table.clear();
      expect(table.getStats()).toEqual({
        fileCount: 0,
        globalSymbolCount: 0,
        fuzzyCallCount: 0,
        fuzzyCallableCallCount: 0,
      });
      expect(table.lookupExact('src/a.ts', 'foo')).toBeUndefined();
      expect(table.lookupFuzzy('foo')).toEqual([]);
      expect(table.lookupFieldByOwner('class:User', 'address')).toBeUndefined();
      expect(table.lookupMethodByOwner('class:User', 'save')).toBeUndefined();
      expect(table.lookupFuzzyCallable('foo')).toEqual([]);
      expect(table.lookupClassByName('User')).toEqual([]);
    });

    it('allows re-adding after clear', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      table.clear();
      table.add('src/b.ts', 'bar', 'func:bar', 'Function');
      expect(table.getStats()).toEqual({
        fileCount: 1,
        globalSymbolCount: 1,
        fuzzyCallCount: 0,
        fuzzyCallableCallCount: 0,
      });
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

  describe('lookupClassByName', () => {
    it('returns Class definitions by name', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      const results = table.lookupClassByName('User');
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        nodeId: 'class:User',
        filePath: 'src/models.ts',
        type: 'Class',
        qualifiedName: 'User',
      });
    });

    it('returns Struct definitions by name', () => {
      table.add('src/models.rs', 'Point', 'struct:Point', 'Struct');
      const results = table.lookupClassByName('Point');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('Struct');
    });

    it('returns Interface definitions by name', () => {
      table.add('src/types.ts', 'Serializable', 'iface:Serializable', 'Interface');
      const results = table.lookupClassByName('Serializable');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('Interface');
    });

    it('returns Enum definitions by name', () => {
      table.add('src/types.ts', 'Color', 'enum:Color', 'Enum');
      const results = table.lookupClassByName('Color');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('Enum');
    });

    it('returns Record definitions by name', () => {
      table.add('src/models.java', 'Config', 'record:Config', 'Record');
      const results = table.lookupClassByName('Config');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('Record');
    });

    it('does NOT include Function with the same name', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      table.add('src/utils.ts', 'User', 'func:User', 'Function');
      const results = table.lookupClassByName('User');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('Class');
      expect(results[0].nodeId).toBe('class:User');
    });

    it('does NOT include Method, Variable, Property, or Constructor', () => {
      table.add('src/a.ts', 'Foo', 'method:Foo', 'Method');
      table.add('src/a.ts', 'Bar', 'var:Bar', 'Variable');
      table.add('src/a.ts', 'Baz', 'prop:Baz', 'Property');
      table.add('src/a.ts', 'Qux', 'ctor:Qux', 'Constructor');
      expect(table.lookupClassByName('Foo')).toEqual([]);
      expect(table.lookupClassByName('Bar')).toEqual([]);
      expect(table.lookupClassByName('Baz')).toEqual([]);
      expect(table.lookupClassByName('Qux')).toEqual([]);
    });

    it('includes Trait in the class set (PHP use, Rust impl, Scala traits)', () => {
      // Traits are class-like for heritage resolution — they contribute
      // methods to the using/implementing type's hierarchy. buildHeritageMap
      // relies on this to resolve `use Trait;` edges in PHP, `impl Trait for
      // Struct` in Rust, etc. Added as part of PR #744 (SM-11 Codex review
      // fixes) after the PHP HasTimestamps trait walk gap was discovered.
      table.add('src/a.rs', 'Writer', 'trait:Writer', 'Trait');
      const results = table.lookupClassByName('Writer');
      expect(results).toHaveLength(1);
      expect(results[0].nodeId).toBe('trait:Writer');
    });

    it('does NOT include other type-like labels outside the allowed class set', () => {
      table.add('src/a.ts', 'User', 'type:User', 'Type');
      expect(table.lookupClassByName('User')).toEqual([]);
    });

    it('returns multiple classes with the same name from different files', () => {
      table.add('src/models/user.ts', 'User', 'class:user:User', 'Class');
      table.add('src/dto/user.ts', 'User', 'class:dto:User', 'Class');
      const results = table.lookupClassByName('User');
      expect(results).toHaveLength(2);
      expect(results[0].filePath).toBe('src/models/user.ts');
      expect(results[1].filePath).toBe('src/dto/user.ts');
    });

    it('returns empty array for unknown name', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      expect(table.lookupClassByName('NonExistent')).toEqual([]);
    });

    it('returns empty array for empty table', () => {
      expect(table.lookupClassByName('User')).toEqual([]);
    });

    it('after clear(), returns empty array', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      expect(table.lookupClassByName('User')).toHaveLength(1);
      table.clear();
      expect(table.lookupClassByName('User')).toEqual([]);
    });

    it('returns mixed class-like types with the same name', () => {
      // e.g. a Class and an Interface both named 'Comparable' in different files
      table.add('src/base.ts', 'Comparable', 'class:Comparable', 'Class');
      table.add('src/types.ts', 'Comparable', 'iface:Comparable', 'Interface');
      const results = table.lookupClassByName('Comparable');
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.type)).toEqual(['Class', 'Interface']);
    });

    it('preserves metadata on indexed class definitions', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class', {
        returnType: 'User',
        ownerId: 'module:models',
      });
      const results = table.lookupClassByName('User');
      expect(results).toHaveLength(1);
      expect(results[0].ownerId).toBe('module:models');
    });

    it('class-like symbols are still available via lookupFuzzy', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      // classByName is an additional index, not a replacement for globalIndex
      expect(table.lookupFuzzy('User')).toHaveLength(1);
      expect(table.lookupClassByName('User')).toHaveLength(1);
    });

    it('allows re-adding after clear and returns correct results', () => {
      table.add('src/models.ts', 'User', 'class:User:v1', 'Class');
      table.clear();
      table.add('src/models.ts', 'User', 'class:User:v2', 'Class');
      const results = table.lookupClassByName('User');
      expect(results).toHaveLength(1);
      expect(results[0].nodeId).toBe('class:User:v2');
    });
  });

  describe('lookupClassByQualifiedName', () => {
    it('indexes class-like definitions by qualified name without replacing simple-name lookup', () => {
      table.add('src/services/user.cs', 'User', 'class:services:User', 'Class', {
        qualifiedName: 'Services.User',
      });
      table.add('src/data/user.cs', 'User', 'class:data:User', 'Class', {
        qualifiedName: 'Data.User',
      });

      expect(table.lookupClassByName('User')).toHaveLength(2);
      expect(table.lookupClassByQualifiedName('Services.User')).toEqual([
        {
          nodeId: 'class:services:User',
          filePath: 'src/services/user.cs',
          type: 'Class',
          qualifiedName: 'Services.User',
        },
      ]);
      const dataUserMatches = table.lookupClassByQualifiedName('Data.User');
      expect(dataUserMatches).toHaveLength(1);
      expect(dataUserMatches[0].qualifiedName).toBe('Data.User');
    });

    it('falls back to the simple name when no qualified metadata is provided', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      expect(table.lookupClassByQualifiedName('User')).toEqual([
        {
          nodeId: 'class:User',
          filePath: 'src/models.ts',
          type: 'Class',
          qualifiedName: 'User',
        },
      ]);
    });

    it('returns empty array for non-class-like types even when qualified metadata is present', () => {
      table.add('src/utils.ts', 'User', 'func:User', 'Function', {
        qualifiedName: 'Services.User',
      });
      expect(table.lookupClassByQualifiedName('Services.User')).toEqual([]);
    });

    it('after clear(), returns empty array', () => {
      table.add('src/services/user.cs', 'User', 'class:User', 'Class', {
        qualifiedName: 'Services.User',
      });
      expect(table.lookupClassByQualifiedName('Services.User')).toHaveLength(1);
      table.clear();
      expect(table.lookupClassByQualifiedName('Services.User')).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// lookupMethodByOwnerWithMRO — MRO-aware method resolution via HeritageMap
// ---------------------------------------------------------------------------

import { buildHeritageMap } from '../../src/core/ingestion/heritage-map.js';
import { lookupMethodByOwnerWithMRO } from '../../src/core/ingestion/call-processor.js';
import {
  createResolutionContext,
  type ResolutionContext,
} from '../../src/core/ingestion/resolution-context.js';
import { SupportedLanguages } from 'gitnexus-shared';
import type { ExtractedHeritage } from '../../src/core/ingestion/workers/parse-worker.js';

describe('lookupMethodByOwnerWithMRO', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('child.parentMethod() resolves to Parent#parentMethod via MRO walk', () => {
    ctx.symbols.add('src/parent.java', 'Parent', 'class:Parent', 'Class');
    ctx.symbols.add('src/child.java', 'Child', 'class:Child', 'Class');
    ctx.symbols.add('src/parent.java', 'parentMethod', 'method:Parent:parentMethod', 'Method', {
      returnType: 'String',
      ownerId: 'class:Parent',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/child.java', className: 'Child', parentName: 'Parent', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:Child',
      'parentMethod',
      map,
      ctx.symbols,
      SupportedLanguages.Java,
    );
    expect(result).toBeDefined();
    expect(result!.nodeId).toBe('method:Parent:parentMethod');
    expect(result!.returnType).toBe('String');
  });

  it('child override returns child version (direct hit, no walk)', () => {
    ctx.symbols.add('src/parent.java', 'Parent', 'class:Parent', 'Class');
    ctx.symbols.add('src/child.java', 'Child', 'class:Child', 'Class');
    ctx.symbols.add('src/parent.java', 'save', 'method:Parent:save', 'Method', {
      returnType: 'void',
      ownerId: 'class:Parent',
    });
    ctx.symbols.add('src/child.java', 'save', 'method:Child:save', 'Method', {
      returnType: 'void',
      ownerId: 'class:Child',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/child.java', className: 'Child', parentName: 'Parent', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:Child',
      'save',
      map,
      ctx.symbols,
      SupportedLanguages.Java,
    );
    expect(result).toBeDefined();
    expect(result!.nodeId).toBe('method:Child:save');
  });

  it('3-level inheritance: grandchild → child → parent, method on parent found', () => {
    ctx.symbols.add('src/a.java', 'A', 'class:A', 'Class');
    ctx.symbols.add('src/b.java', 'B', 'class:B', 'Class');
    ctx.symbols.add('src/c.java', 'C', 'class:C', 'Class');
    ctx.symbols.add('src/a.java', 'greet', 'method:A:greet', 'Method', {
      returnType: 'Greeting',
      ownerId: 'class:A',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/c.java', className: 'C', parentName: 'B', kind: 'extends' },
      { filePath: 'src/b.java', className: 'B', parentName: 'A', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:C',
      'greet',
      map,
      ctx.symbols,
      SupportedLanguages.Java,
    );
    expect(result).toBeDefined();
    expect(result!.nodeId).toBe('method:A:greet');
    expect(result!.returnType).toBe('Greeting');
  });

  it('diamond pattern: first-wins strategy returns first ancestor match in BFS order', () => {
    ctx.symbols.add('src/a.ts', 'A', 'class:A', 'Class');
    ctx.symbols.add('src/b.ts', 'B', 'class:B', 'Class');
    ctx.symbols.add('src/c.ts', 'C', 'class:C', 'Class');
    ctx.symbols.add('src/d.ts', 'D', 'class:D', 'Class');
    ctx.symbols.add('src/b.ts', 'foo', 'method:B:foo', 'Method', {
      returnType: 'String',
      ownerId: 'class:B',
    });
    ctx.symbols.add('src/c.ts', 'foo', 'method:C:foo', 'Method', {
      returnType: 'String',
      ownerId: 'class:C',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/d.ts', className: 'D', parentName: 'B', kind: 'extends' },
      { filePath: 'src/d.ts', className: 'D', parentName: 'C', kind: 'extends' },
      { filePath: 'src/b.ts', className: 'B', parentName: 'A', kind: 'extends' },
      { filePath: 'src/c.ts', className: 'C', parentName: 'A', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    // TypeScript uses 'first-wins' — B is first parent, so B.foo wins
    const result = lookupMethodByOwnerWithMRO(
      'class:D',
      'foo',
      map,
      ctx.symbols,
      SupportedLanguages.TypeScript,
    );
    expect(result).toBeDefined();
    expect(result!.nodeId).toBe('method:B:foo');
  });

  it('diamond pattern: c3 strategy uses C3 linearization order', () => {
    ctx.symbols.add('src/a.py', 'A', 'class:A', 'Class');
    ctx.symbols.add('src/b.py', 'B', 'class:B', 'Class');
    ctx.symbols.add('src/c.py', 'C', 'class:C', 'Class');
    ctx.symbols.add('src/d.py', 'D', 'class:D', 'Class');
    ctx.symbols.add('src/b.py', 'foo', 'method:B:foo', 'Method', {
      returnType: 'str',
      ownerId: 'class:B',
    });
    ctx.symbols.add('src/c.py', 'foo', 'method:C:foo', 'Method', {
      returnType: 'str',
      ownerId: 'class:C',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/d.py', className: 'D', parentName: 'B', kind: 'extends' },
      { filePath: 'src/d.py', className: 'D', parentName: 'C', kind: 'extends' },
      { filePath: 'src/b.py', className: 'B', parentName: 'A', kind: 'extends' },
      { filePath: 'src/c.py', className: 'C', parentName: 'A', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    // Python uses 'c3' — C3 linearization for D(B,C): [B, C, A]
    const result = lookupMethodByOwnerWithMRO(
      'class:D',
      'foo',
      map,
      ctx.symbols,
      SupportedLanguages.Python,
    );
    expect(result).toBeDefined();
    // C3 linearization resolves to B before C in this hierarchy
    expect(result!.nodeId).toBe('method:B:foo');
  });

  it('qualified-syntax (Rust): returns undefined for inherited methods', () => {
    ctx.symbols.add('src/parent.rs', 'Parent', 'class:Parent', 'Class');
    ctx.symbols.add('src/child.rs', 'Child', 'class:Child', 'Class');
    ctx.symbols.add('src/parent.rs', 'process', 'method:Parent:process', 'Method', {
      returnType: 'void',
      ownerId: 'class:Parent',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/child.rs', className: 'Child', parentName: 'Parent', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:Child',
      'process',
      map,
      ctx.symbols,
      SupportedLanguages.Rust,
    );
    // Rust requires qualified syntax — no auto-resolution
    expect(result).toBeUndefined();
  });

  it('method not on any ancestor returns undefined', () => {
    ctx.symbols.add('src/parent.java', 'Parent', 'class:Parent', 'Class');
    ctx.symbols.add('src/child.java', 'Child', 'class:Child', 'Class');

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/child.java', className: 'Child', parentName: 'Parent', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:Child',
      'nonExistent',
      map,
      ctx.symbols,
      SupportedLanguages.Java,
    );
    expect(result).toBeUndefined();
  });

  it('leftmost-base (C++): walks ancestors in BFS order', () => {
    ctx.symbols.add('src/a.cpp', 'A', 'class:A', 'Class');
    ctx.symbols.add('src/b.cpp', 'B', 'class:B', 'Class');
    ctx.symbols.add('src/c.cpp', 'C', 'class:C', 'Class');
    ctx.symbols.add('src/a.cpp', 'render', 'method:A:render', 'Method', {
      returnType: 'void',
      ownerId: 'class:A',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/c.cpp', className: 'C', parentName: 'B', kind: 'extends' },
      { filePath: 'src/b.cpp', className: 'B', parentName: 'A', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:C',
      'render',
      map,
      ctx.symbols,
      SupportedLanguages.CPlusPlus,
    );
    expect(result).toBeDefined();
    expect(result!.nodeId).toBe('method:A:render');
  });

  it('implements-split (Java): walks ancestors to find inherited method', () => {
    ctx.symbols.add('src/base.java', 'Base', 'class:Base', 'Class');
    ctx.symbols.add('src/iface.java', 'IRepo', 'iface:IRepo', 'Interface');
    ctx.symbols.add('src/child.java', 'Child', 'class:Child', 'Class');
    ctx.symbols.add('src/base.java', 'save', 'method:Base:save', 'Method', {
      returnType: 'void',
      ownerId: 'class:Base',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/child.java', className: 'Child', parentName: 'Base', kind: 'extends' },
      {
        filePath: 'src/child.java',
        className: 'Child',
        parentName: 'IRepo',
        kind: 'implements',
      },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:Child',
      'save',
      map,
      ctx.symbols,
      SupportedLanguages.Java,
    );
    expect(result).toBeDefined();
    expect(result!.nodeId).toBe('method:Base:save');
  });

  it('implements-split (Java): ambiguous default from two interfaces → BFS first-wins', () => {
    // Java: class C implements I1, I2; both I1 and I2 declare the same
    // default method. Full ambiguity detection (Java's "class must override
    // conflicting defaults" rule) is deferred to computeMRO at the graph
    // level. lookupMethodByOwnerWithMRO itself uses BFS order and returns
    // the first match — this test pins that contract so a future regression
    // that starts returning undefined (or flips the order) fails loudly.
    ctx.symbols.add('src/I1.java', 'I1', 'iface:I1', 'Interface');
    ctx.symbols.add('src/I2.java', 'I2', 'iface:I2', 'Interface');
    ctx.symbols.add('src/C.java', 'C', 'class:C', 'Class');
    ctx.symbols.add('src/I1.java', 'handle', 'method:I1:handle', 'Method', {
      returnType: 'void',
      ownerId: 'iface:I1',
    });
    ctx.symbols.add('src/I2.java', 'handle', 'method:I2:handle', 'Method', {
      returnType: 'void',
      ownerId: 'iface:I2',
    });

    // Insertion order is I1 then I2, so BFS returns I1 first.
    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/C.java', className: 'C', parentName: 'I1', kind: 'implements' },
      { filePath: 'src/C.java', className: 'C', parentName: 'I2', kind: 'implements' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:C',
      'handle',
      map,
      ctx.symbols,
      SupportedLanguages.Java,
    );
    expect(result).toBeDefined();
    // BFS first-wins — I1 was declared first, so it wins.
    expect(result!.nodeId).toBe('method:I1:handle');
  });

  it('implements-split (Java): class method takes precedence over interface default in BFS order', () => {
    // Child extends Base implements IFoo. Both Base (class) and IFoo
    // (interface) declare the same method. HeritageMap records extends
    // before implements in the emitter's declaration order, so BFS visits
    // Base before IFoo — class wins. Documents the current BFS-level
    // behavior; the strict Java "class always wins" rule is enforced at
    // the mro-processor graph pass.
    ctx.symbols.add('src/Base.java', 'Base', 'class:Base', 'Class');
    ctx.symbols.add('src/IFoo.java', 'IFoo', 'iface:IFoo', 'Interface');
    ctx.symbols.add('src/Child.java', 'Child', 'class:Child', 'Class');
    ctx.symbols.add('src/Base.java', 'handle', 'method:Base:handle', 'Method', {
      returnType: 'void',
      ownerId: 'class:Base',
    });
    ctx.symbols.add('src/IFoo.java', 'handle', 'method:IFoo:handle', 'Method', {
      returnType: 'void',
      ownerId: 'iface:IFoo',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/Child.java', className: 'Child', parentName: 'Base', kind: 'extends' },
      { filePath: 'src/Child.java', className: 'Child', parentName: 'IFoo', kind: 'implements' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:Child',
      'handle',
      map,
      ctx.symbols,
      SupportedLanguages.Java,
    );
    expect(result).toBeDefined();
    expect(result!.nodeId).toBe('method:Base:handle');
  });

  it('implements-split (Kotlin): walks ancestors to find inherited method', () => {
    ctx.symbols.add('src/base.kt', 'Base', 'class:Base', 'Class');
    ctx.symbols.add('src/child.kt', 'Child', 'class:Child', 'Class');
    ctx.symbols.add('src/base.kt', 'handle', 'method:Base:handle', 'Method', {
      returnType: 'Unit',
      ownerId: 'class:Base',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/child.kt', className: 'Child', parentName: 'Base', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:Child',
      'handle',
      map,
      ctx.symbols,
      SupportedLanguages.Kotlin,
    );
    expect(result).toBeDefined();
    expect(result!.nodeId).toBe('method:Base:handle');
  });

  it('implements-split (C#): walks ancestors to find inherited method', () => {
    ctx.symbols.add('src/Base.cs', 'Base', 'class:Base', 'Class');
    ctx.symbols.add('src/Child.cs', 'Child', 'class:Child', 'Class');
    ctx.symbols.add('src/Base.cs', 'Execute', 'method:Base:Execute', 'Method', {
      returnType: 'void',
      ownerId: 'class:Base',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/Child.cs', className: 'Child', parentName: 'Base', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:Child',
      'Execute',
      map,
      ctx.symbols,
      SupportedLanguages.CSharp,
    );
    expect(result).toBeDefined();
    expect(result!.nodeId).toBe('method:Base:Execute');
  });

  it('first-wins (JavaScript): walks ancestors to find inherited method', () => {
    // JavaScript provider is wired separately from TypeScript — this guards
    // the provider wiring independent of the TS path.
    ctx.symbols.add('src/animal.js', 'Animal', 'class:Animal', 'Class');
    ctx.symbols.add('src/dog.js', 'Dog', 'class:Dog', 'Class');
    ctx.symbols.add('src/animal.js', 'speak', 'method:Animal:speak', 'Method', {
      returnType: 'string',
      ownerId: 'class:Animal',
    });

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/dog.js', className: 'Dog', parentName: 'Animal', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:Dog',
      'speak',
      map,
      ctx.symbols,
      SupportedLanguages.JavaScript,
    );
    expect(result).toBeDefined();
    expect(result!.nodeId).toBe('method:Animal:speak');
  });

  it('leftmost-base (C++): diamond inheritance resolves leftmost branch first', () => {
    // Diamond: D extends B, C; B extends A; C extends A.
    // Both B and C define render(). leftmost-base must return B#render (first
    // branch in declaration order), not A#render or C#render.
    ctx.symbols.add('src/a.cpp', 'A', 'class:A', 'Class');
    ctx.symbols.add('src/b.cpp', 'B', 'class:B', 'Class');
    ctx.symbols.add('src/c.cpp', 'C', 'class:C', 'Class');
    ctx.symbols.add('src/d.cpp', 'D', 'class:D', 'Class');
    ctx.symbols.add('src/a.cpp', 'render', 'method:A:render', 'Method', {
      returnType: 'void',
      ownerId: 'class:A',
    });
    ctx.symbols.add('src/b.cpp', 'render', 'method:B:render', 'Method', {
      returnType: 'void',
      ownerId: 'class:B',
    });
    ctx.symbols.add('src/c.cpp', 'render', 'method:C:render', 'Method', {
      returnType: 'void',
      ownerId: 'class:C',
    });

    const heritage: ExtractedHeritage[] = [
      // Declaration order matters: B before C for leftmost-base semantics.
      { filePath: 'src/d.cpp', className: 'D', parentName: 'B', kind: 'extends' },
      { filePath: 'src/d.cpp', className: 'D', parentName: 'C', kind: 'extends' },
      { filePath: 'src/b.cpp', className: 'B', parentName: 'A', kind: 'extends' },
      { filePath: 'src/c.cpp', className: 'C', parentName: 'A', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:D',
      'render',
      map,
      ctx.symbols,
      SupportedLanguages.CPlusPlus,
    );
    expect(result).toBeDefined();
    // BFS via HeritageMap visits B before C (insertion order), so leftmost
    // branch wins — matches C++ leftmost-base semantics for non-virtual base.
    expect(result!.nodeId).toBe('method:B:render');
  });

  it('returns direct method on owner without walking (no heritage needed)', () => {
    ctx.symbols.add('src/user.java', 'User', 'class:User', 'Class');
    ctx.symbols.add('src/user.java', 'getName', 'method:User:getName', 'Method', {
      returnType: 'String',
      ownerId: 'class:User',
    });

    const map = buildHeritageMap([], ctx);

    const result = lookupMethodByOwnerWithMRO(
      'class:User',
      'getName',
      map,
      ctx.symbols,
      SupportedLanguages.Java,
    );
    expect(result).toBeDefined();
    expect(result!.nodeId).toBe('method:User:getName');
  });
});

// ---------------------------------------------------------------------------
// resolveMemberCall — SM-11: owner-scoped + MRO member-call resolution
// ---------------------------------------------------------------------------

import {
  _resolveCallTargetForTesting,
  resolveMemberCall,
  type OverloadHints,
} from '../../src/core/ingestion/call-processor.js';

describe('resolveMemberCall', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('resolves direct method on owner type', () => {
    ctx.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    ctx.symbols.add('src/user.ts', 'save', 'method:User:save', 'Method', {
      returnType: 'void',
      ownerId: 'class:User',
    });
    ctx.importMap.set('src/app.ts', new Set(['src/user.ts']));

    const result = resolveMemberCall('User', 'save', 'src/app.ts', ctx);

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('method:User:save');
    expect(result!.returnType).toBe('void');
    expect(result!.confidence).toBeGreaterThan(0);
  });

  it('resolves inherited method via MRO walk', () => {
    ctx.symbols.add('src/parent.java', 'Parent', 'class:Parent', 'Class');
    ctx.symbols.add('src/child.java', 'Child', 'class:Child', 'Class');
    ctx.symbols.add('src/parent.java', 'validate', 'method:Parent:validate', 'Method', {
      returnType: 'boolean',
      ownerId: 'class:Parent',
    });
    ctx.importMap.set('src/app.java', new Set(['src/child.java', 'src/parent.java']));

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/child.java', className: 'Child', parentName: 'Parent', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = resolveMemberCall('Child', 'validate', 'src/app.java', ctx, map);

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('method:Parent:validate');
    expect(result!.returnType).toBe('boolean');
  });

  it('returns null for unknown owner type', () => {
    const result = resolveMemberCall('NonExistent', 'save', 'src/app.ts', ctx);
    expect(result).toBeNull();
  });

  it('returns null for unknown method on known owner', () => {
    ctx.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    ctx.importMap.set('src/app.ts', new Set(['src/user.ts']));

    const result = resolveMemberCall('User', 'nonExistentMethod', 'src/app.ts', ctx);
    expect(result).toBeNull();
  });

  it('returns result with correct confidence tier for same-file resolution', () => {
    ctx.symbols.add('src/app.ts', 'User', 'class:User', 'Class');
    ctx.symbols.add('src/app.ts', 'save', 'method:User:save', 'Method', {
      returnType: 'void',
      ownerId: 'class:User',
    });

    const result = resolveMemberCall('User', 'save', 'src/app.ts', ctx);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.95); // same-file tier
    expect(result!.reason).toBe('same-file');
  });

  it('returns result with import-scoped tier for cross-file resolution', () => {
    ctx.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    ctx.symbols.add('src/user.ts', 'save', 'method:User:save', 'Method', {
      returnType: 'void',
      ownerId: 'class:User',
    });
    ctx.importMap.set('src/app.ts', new Set(['src/user.ts']));

    const result = resolveMemberCall('User', 'save', 'src/app.ts', ctx);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.9); // import-scoped tier
    expect(result!.reason).toBe('import-resolved');
  });

  it('resolves with heritage map across C3 MRO chain (Python)', () => {
    ctx.symbols.add('src/a.py', 'A', 'class:A', 'Class');
    ctx.symbols.add('src/b.py', 'B', 'class:B', 'Class');
    ctx.symbols.add('src/c.py', 'C', 'class:C', 'Class');
    ctx.symbols.add('src/a.py', 'foo', 'method:A:foo', 'Method', {
      returnType: 'str',
      ownerId: 'class:A',
    });
    ctx.importMap.set('src/main.py', new Set(['src/a.py', 'src/b.py', 'src/c.py']));

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/c.py', className: 'C', parentName: 'B', kind: 'extends' },
      { filePath: 'src/b.py', className: 'B', parentName: 'A', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = resolveMemberCall('C', 'foo', 'src/main.py', ctx, map);

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('method:A:foo');
    expect(result!.returnType).toBe('str');
  });

  // -------------------------------------------------------------------------
  // Locks in the B2 semantic change: tier reflects how the OWNER TYPE was
  // resolved, not how the method name was resolved globally.
  // -------------------------------------------------------------------------
  it('uses owner-type tier: cross-file class resolution → import-scoped confidence', () => {
    // Scenario: owner class 'User' is defined in user.ts (imported from app.ts).
    // The method 'save' exists ONLY on User (no homonyms). Old behaviour would
    // have used the tier of resolving "save" globally; new behaviour uses the
    // tier of resolving "User". Both happen to yield import-scoped here —
    // the test locks that the reported tier tracks the class lookup.
    ctx.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    ctx.symbols.add('src/user.ts', 'save', 'method:User:save', 'Method', {
      returnType: 'void',
      ownerId: 'class:User',
    });
    ctx.importMap.set('src/app.ts', new Set(['src/user.ts']));

    const result = resolveMemberCall('User', 'save', 'src/app.ts', ctx);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.9); // import-scoped
    expect(result!.reason).toBe('import-resolved');
  });

  // -------------------------------------------------------------------------
  // T2: Rust qualified-syntax — trait-inherited methods must return null
  // because they require `TraitName::method(obj)` call syntax, not `obj.method()`.
  // Only struct's OWN impl methods are reachable via direct member calls.
  // -------------------------------------------------------------------------
  it('Rust: returns null for trait-inherited method (qualified-syntax MRO)', () => {
    // Trait Writer defines `save`. Struct User has an impl_item but NO save
    // method of its own — save is only available via trait.
    ctx.symbols.add('src/writer.rs', 'Writer', 'trait:Writer', 'Trait');
    ctx.symbols.add('src/user.rs', 'User', 'struct:User', 'Struct');
    ctx.symbols.add('src/writer.rs', 'save', 'method:Writer:save', 'Method', {
      returnType: 'bool',
      ownerId: 'trait:Writer',
    });
    ctx.importMap.set('src/app.rs', new Set(['src/writer.rs', 'src/user.rs']));

    const heritage: ExtractedHeritage[] = [
      // User implements Writer — in Rust this is `impl Writer for User`.
      { filePath: 'src/user.rs', className: 'User', parentName: 'Writer', kind: 'implements' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    // Rust's qualified-syntax strategy short-circuits trait inheritance walks,
    // so `user.save()` (direct call) does not resolve.
    const result = resolveMemberCall('User', 'save', 'src/app.rs', ctx, map);
    expect(result).toBeNull();
  });

  it('Rust: direct impl methods still resolve (distinction check for T2)', () => {
    // Positive control: a method defined directly on User (not via trait)
    // resolves normally — demonstrates the null in the previous test is
    // specifically due to the trait-inheritance path, not a broken fixture.
    ctx.symbols.add('src/user.rs', 'User', 'struct:User', 'Struct');
    ctx.symbols.add('src/user.rs', 'name', 'method:User:name', 'Method', {
      returnType: 'String',
      ownerId: 'struct:User',
    });
    ctx.importMap.set('src/app.rs', new Set(['src/user.rs']));

    const result = resolveMemberCall('User', 'name', 'src/app.rs', ctx);
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('method:User:name');
    expect(result!.returnType).toBe('String');
  });

  // -------------------------------------------------------------------------
  // T3: C/C++ leftmost-base diamond inheritance at the resolveMemberCall layer.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Homonym disambiguation: when two class candidates share a name but only
  // ONE of them owns the method, resolveMemberCall should return that one
  // without falling through to the fuzzy D2 widening path. Absorbs what was
  // previously D4's ownerId-filtering job into the owner-scoped path.
  // -------------------------------------------------------------------------
  it('disambiguates homonym classes: only one owns the method', () => {
    // Two classes both named `User` — one in auth.py (has `save`), one in
    // legacy.py (has `archive` but no `save`). Both are imported from app.py.
    ctx.symbols.add('src/auth.py', 'User', 'class:auth:User', 'Class');
    ctx.symbols.add('src/auth.py', 'save', 'method:auth:User:save', 'Method', {
      returnType: 'None',
      ownerId: 'class:auth:User',
    });
    ctx.symbols.add('src/legacy.py', 'User', 'class:legacy:User', 'Class');
    ctx.symbols.add('src/legacy.py', 'archive', 'method:legacy:User:archive', 'Method', {
      returnType: 'None',
      ownerId: 'class:legacy:User',
    });
    ctx.importMap.set('src/app.py', new Set(['src/auth.py', 'src/legacy.py']));

    // `user.save()` is unambiguous — only auth.User has `save`.
    const saveResult = resolveMemberCall('User', 'save', 'src/app.py', ctx);
    expect(saveResult).not.toBeNull();
    expect(saveResult!.nodeId).toBe('method:auth:User:save');

    // `user.archive()` is also unambiguous — only legacy.User has `archive`.
    const archiveResult = resolveMemberCall('User', 'archive', 'src/app.py', ctx);
    expect(archiveResult).not.toBeNull();
    expect(archiveResult!.nodeId).toBe('method:legacy:User:archive');
  });

  it('returns null when homonym classes BOTH own the method (genuine ambiguity)', () => {
    // Both homonym Users define a `save` method — resolveMemberCall refuses
    // to pick one. The caller (resolveCallTarget) falls through to D1-D4 which
    // may or may not be able to narrow further.
    ctx.symbols.add('src/auth.py', 'User', 'class:auth:User', 'Class');
    ctx.symbols.add('src/auth.py', 'save', 'method:auth:User:save', 'Method', {
      returnType: 'None',
      ownerId: 'class:auth:User',
    });
    ctx.symbols.add('src/legacy.py', 'User', 'class:legacy:User', 'Class');
    ctx.symbols.add('src/legacy.py', 'save', 'method:legacy:User:save', 'Method', {
      returnType: 'None',
      ownerId: 'class:legacy:User',
    });
    ctx.importMap.set('src/app.py', new Set(['src/auth.py', 'src/legacy.py']));

    const result = resolveMemberCall('User', 'save', 'src/app.py', ctx);
    expect(result).toBeNull();
  });

  it('homonym + shared ancestor: both walk MRO to the same method (dedups to 1)', () => {
    // Two homonym `User` classes in different files, both extending a common
    // `BaseUser` that owns `save`. Direct lookup on either User misses; MRO
    // walks both find BaseUser.save. Dedup by nodeId yields a single result.
    ctx.symbols.add('src/base.ts', 'BaseUser', 'class:BaseUser', 'Class');
    ctx.symbols.add('src/base.ts', 'save', 'method:BaseUser:save', 'Method', {
      returnType: 'void',
      ownerId: 'class:BaseUser',
    });
    ctx.symbols.add('src/a.ts', 'User', 'class:a:User', 'Class');
    ctx.symbols.add('src/b.ts', 'User', 'class:b:User', 'Class');
    ctx.importMap.set('src/app.ts', new Set(['src/base.ts', 'src/a.ts', 'src/b.ts']));

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/a.ts', className: 'User', parentName: 'BaseUser', kind: 'extends' },
      { filePath: 'src/b.ts', className: 'User', parentName: 'BaseUser', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = resolveMemberCall('User', 'save', 'src/app.ts', ctx, map);
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('method:BaseUser:save');
  });

  it('C++: resolves diamond inheritance via leftmost-base MRO', () => {
    // Diamond:
    //        Base
    //        / \
    //       A   B
    //        \ /
    //      Derived
    //
    // Both A and B inherit `method` from Base. Derived extends (A, B).
    // Leftmost-base strategy walks A's chain first → finds Base::method.
    ctx.symbols.add('src/base.h', 'Base', 'class:Base', 'Class');
    ctx.symbols.add('src/a.h', 'A', 'class:A', 'Class');
    ctx.symbols.add('src/b.h', 'B', 'class:B', 'Class');
    ctx.symbols.add('src/derived.h', 'Derived', 'class:Derived', 'Class');
    ctx.symbols.add('src/base.h', 'method', 'method:Base:method', 'Method', {
      returnType: 'int',
      ownerId: 'class:Base',
    });
    ctx.importMap.set(
      'src/app.cpp',
      new Set(['src/base.h', 'src/a.h', 'src/b.h', 'src/derived.h']),
    );

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/a.h', className: 'A', parentName: 'Base', kind: 'extends' },
      { filePath: 'src/b.h', className: 'B', parentName: 'Base', kind: 'extends' },
      { filePath: 'src/derived.h', className: 'Derived', parentName: 'A', kind: 'extends' },
      { filePath: 'src/derived.h', className: 'Derived', parentName: 'B', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = resolveMemberCall('Derived', 'method', 'src/app.cpp', ctx, map);

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('method:Base:method');
    expect(result!.returnType).toBe('int');
  });

  // -------------------------------------------------------------------------
  // L1: C# / Kotlin implements-split strategy through resolveMemberCall.
  // lookupMethodByOwnerWithMRO already has strategy-level coverage for these
  // languages; these tests add the resolveMemberCall layer (tier resolution
  // + class candidate iteration + MRO walk) on top.
  // -------------------------------------------------------------------------
  it('C#: walks implements-split to find inherited method via interface', () => {
    // C# uses implements-split MRO: class base chain walked first, then
    // interfaces. Here IService declares Save which is implemented by the
    // base class BaseService — MyService inherits Save through the class.
    ctx.symbols.add('src/iservice.cs', 'IService', 'interface:IService', 'Interface');
    ctx.symbols.add('src/base.cs', 'BaseService', 'class:BaseService', 'Class');
    ctx.symbols.add('src/my.cs', 'MyService', 'class:MyService', 'Class');
    ctx.symbols.add('src/base.cs', 'Save', 'method:BaseService:Save', 'Method', {
      returnType: 'void',
      ownerId: 'class:BaseService',
    });
    ctx.importMap.set('src/app.cs', new Set(['src/iservice.cs', 'src/base.cs', 'src/my.cs']));

    const heritage: ExtractedHeritage[] = [
      {
        filePath: 'src/base.cs',
        className: 'BaseService',
        parentName: 'IService',
        kind: 'implements',
      },
      { filePath: 'src/my.cs', className: 'MyService', parentName: 'BaseService', kind: 'extends' },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = resolveMemberCall('MyService', 'Save', 'src/app.cs', ctx, map);

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('method:BaseService:Save');
    expect(result!.returnType).toBe('void');
  });

  it('Kotlin: walks implements-split to find inherited method via interface', () => {
    // Kotlin shares the implements-split MRO strategy with Java/C#. A class
    // inheriting from an interface that provides a default method should
    // resolve `obj.method()` to the interface's implementation.
    ctx.symbols.add('src/validator.kt', 'Validator', 'interface:Validator', 'Interface');
    ctx.symbols.add('src/user.kt', 'User', 'class:User', 'Class');
    ctx.symbols.add('src/validator.kt', 'validate', 'method:Validator:validate', 'Method', {
      returnType: 'Boolean',
      ownerId: 'interface:Validator',
    });
    ctx.importMap.set('src/app.kt', new Set(['src/validator.kt', 'src/user.kt']));

    const heritage: ExtractedHeritage[] = [
      {
        filePath: 'src/user.kt',
        className: 'User',
        parentName: 'Validator',
        kind: 'implements',
      },
    ];
    const map = buildHeritageMap(heritage, ctx);

    const result = resolveMemberCall('User', 'validate', 'src/app.kt', ctx, map);

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('method:Validator:validate');
    expect(result!.returnType).toBe('Boolean');
  });
});

// ---------------------------------------------------------------------------
// T1: D0 skip-condition tests — verify resolveCallTarget bypasses the
// resolveMemberCall fast path when overloadHints, preComputedArgTypes, or a
// module alias is active.
// ---------------------------------------------------------------------------

describe('resolveCallTarget D0 skip conditions (SM-11)', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('module alias: picks alias-scoped class over homonym (D0 actually bypassed)', () => {
    // Python-style: `import auth; auth.User.save()` where BOTH auth.py and
    // other.py define a `User` class with a `save` method. The test proves:
    //
    //   1. Without the alias: resolveMemberCall sees two homonym Users,
    //      both own `save`, and correctly returns null (refuses to guess).
    //   2. With the alias: D0 is skipped via `hasActiveModuleAlias`, and
    //      D1-D4 — respecting the alias-narrowed filteredCandidates — picks
    //      the auth.py User.save method.
    //
    // A regression where D0 silently ran would produce null (ambiguous)
    // instead of the correct answer, so this test actually exercises the
    // skip path rather than just verifying a single-candidate happy path.
    ctx.symbols.add('src/auth.py', 'User', 'class:auth:User', 'Class');
    ctx.symbols.add('src/auth.py', 'save', 'method:auth:User:save', 'Method', {
      returnType: 'None',
      ownerId: 'class:auth:User',
    });
    ctx.symbols.add('src/other.py', 'User', 'class:other:User', 'Class');
    ctx.symbols.add('src/other.py', 'save', 'method:other:User:save', 'Method', {
      returnType: 'None',
      ownerId: 'class:other:User',
    });
    ctx.importMap.set('src/app.py', new Set(['src/auth.py', 'src/other.py']));
    ctx.moduleAliasMap.set('src/app.py', new Map([['auth', 'src/auth.py']]));

    // Control: without alias narrowing, resolveMemberCall sees both Users
    // own `save` and correctly refuses to pick one.
    const ambiguous = resolveMemberCall('User', 'save', 'src/app.py', ctx);
    expect(ambiguous).toBeNull();

    // With alias narrowing active, D0 is skipped and D1-D4 picks auth.py's
    // User.save because the alias block already narrowed filteredCandidates
    // to auth.py (and the D2 widening step is gated on `!aliasNarrowed`).
    const aliased = _resolveCallTargetForTesting(
      {
        calledName: 'save',
        callForm: 'member',
        receiverTypeName: 'User',
        receiverName: 'auth', // triggers hasActiveModuleAlias → D0 skipped
      },
      'src/app.py',
      ctx,
    );

    expect(aliased).not.toBeNull();
    expect(aliased!.nodeId).toBe('method:auth:User:save');
  });

  it('overloadHints present: D0 bypassed, D1-D4 handles resolution', () => {
    // When overloadHints is supplied, the D0 fast path must be skipped
    // because lookupMethodByOwner does not consider argument types and
    // would pick an arbitrary overload for same-return-type overloads.
    //
    // This test verifies that the skip does not break resolution: passing
    // a dummy overloadHints object should still yield the correct method
    // via the D1-D4 path.
    ctx.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    ctx.symbols.add('src/user.ts', 'save', 'method:User:save', 'Method', {
      returnType: 'void',
      ownerId: 'class:User',
    });
    ctx.importMap.set('src/app.ts', new Set(['src/user.ts']));

    // Minimal stub; D1-D4 only calls tryOverloadDisambiguation when there are
    // multiple candidates, so an empty object is fine for single-candidate cases.
    const dummyHints = {} as OverloadHints;

    const result = _resolveCallTargetForTesting(
      {
        calledName: 'save',
        callForm: 'member',
        receiverTypeName: 'User',
      },
      'src/app.ts',
      ctx,
      { overloadHints: dummyHints },
    );

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('method:User:save');
  });

  it('preComputedArgTypes present: D0 bypassed, D1-D4 handles resolution', () => {
    // Analogous to the overloadHints case: when preComputedArgTypes is supplied
    // (worker path), D0 must be skipped so that type-based overload
    // disambiguation in D1-D4 is authoritative.
    ctx.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    ctx.symbols.add('src/user.ts', 'save', 'method:User:save', 'Method', {
      returnType: 'void',
      ownerId: 'class:User',
    });
    ctx.importMap.set('src/app.ts', new Set(['src/user.ts']));

    const result = _resolveCallTargetForTesting(
      {
        calledName: 'save',
        callForm: 'member',
        receiverTypeName: 'User',
        argCount: 0,
      },
      'src/app.ts',
      ctx,
      { preComputedArgTypes: [] },
    );

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('method:User:save');
  });
});
