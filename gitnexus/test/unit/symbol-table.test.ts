import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SymbolTableWriter } from '../../src/core/ingestion/model/symbol-table.js';
import {
  createSemanticModel,
  type MutableSemanticModel,
} from '../../src/core/ingestion/model/semantic-model.js';

describe('SymbolTable', () => {
  // SM-23: SymbolTable is now a pure leaf with no registry knowledge.
  // Tests that exercise owner-scoped lookups (lookupClassByName,
  // lookupMethodByOwner, lookupFieldByOwner, lookupClassByQualifiedName,
  // lookupImplByName) must go through SemanticModel which composes
  // SymbolTable with the registries. We build a model and alias
  // `table = model.symbols` so the 200+ file/callable test cases keep
  // their existing call sites unchanged.
  let model: MutableSemanticModel;
  let table: SymbolTableWriter;

  beforeEach(() => {
    model = createSemanticModel();
    table = model.symbols;
  });

  describe('add', () => {
    it('registers a symbol in the table', () => {
      table.add('src/index.ts', 'main', 'func:main', 'Function');
      expect(table.getStats().fileCount).toBe(1);
    });

    it('handles multiple symbols in the same file', () => {
      table.add('src/index.ts', 'main', 'func:main', 'Function');
      table.add('src/index.ts', 'helper', 'func:helper', 'Function');
      expect(table.getStats().fileCount).toBe(1);
    });

    it('handles same name in different files', () => {
      table.add('src/a.ts', 'init', 'func:a:init', 'Function');
      table.add('src/b.ts', 'init', 'func:b:init', 'Function');
      expect(table.getStats().fileCount).toBe(2);
    });

    it('allows duplicate adds for same file and name (overloads preserved)', () => {
      table.add('src/a.ts', 'foo', 'func:foo:1', 'Function');
      table.add('src/a.ts', 'foo', 'func:foo:2', 'Function');
      // File index stores both overloads; lookupExact returns first
      expect(table.lookupExact('src/a.ts', 'foo')).toBe('func:foo:1');
      // lookupExactAll returns all overloads
      expect(table.lookupExactAll('src/a.ts', 'foo')).toHaveLength(2);
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

  describe('getStats', () => {
    it('returns zero counts for empty table', () => {
      expect(table.getStats()).toEqual({
        fileCount: 0,
      });
    });

    it('tracks unique file count correctly', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      table.add('src/a.ts', 'bar', 'func:bar', 'Function');
      table.add('src/b.ts', 'baz', 'func:baz', 'Function');
      expect(table.getStats().fileCount).toBe(2);
    });
  });

  describe('returnType metadata', () => {
    it('stores returnType in SymbolDefinition', () => {
      table.add('src/utils.ts', 'getUser', 'func:getUser', 'Function', { returnType: 'User' });
      const def = table.lookupExactFull('src/utils.ts', 'getUser');
      expect(def).toBeDefined();
      expect(def!.returnType).toBe('User');
    });

    it('returnType is available via lookupExactFull', () => {
      table.add('src/utils.ts', 'getUser', 'func:getUser', 'Function', {
        returnType: 'Promise<User>',
      });
      const result = table.lookupExactFull('src/utils.ts', 'getUser');
      expect(result).toBeDefined();
      expect(result!.returnType).toBe('Promise<User>');
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

  describe('callable availability metadata', () => {
    it('preserves isDeleted in file, callable, and owner indexes', () => {
      table.add('src/example.cpp', 'choose', 'func:choose:int', 'Function', {
        parameterTypes: ['int'],
        isDeleted: true,
      });
      table.add('src/example.cpp', 'touch', 'method:touch:double', 'Method', {
        ownerId: 'class:Widget',
        parameterTypes: ['double'],
        isDeleted: true,
      });

      expect(table.lookupExactAll('src/example.cpp', 'choose')[0]?.isDeleted).toBe(true);
      expect(table.lookupCallableByName('choose')[0]?.isDeleted).toBe(true);
      expect(model.methods.lookupAllByOwner('class:Widget', 'touch')[0]?.isDeleted).toBe(true);
    });
  });

  describe('Property exclusion from callable index', () => {
    it('Property with ownerId is NOT in callable index', () => {
      table.add('src/models.ts', 'name', 'prop:name', 'Property', {
        declaredType: 'string',
        ownerId: 'class:User',
      });
      // Should not appear in callable lookup
      expect(table.lookupCallableByName('name')).toEqual([]);
      // But should still be in fileIndex
      expect(table.lookupExact('src/models.ts', 'name')).toBe('prop:name');
    });

    it('Property without ownerId is NOT in callable index', () => {
      table.add('src/models.ts', 'name', 'prop:name', 'Property');
      expect(table.lookupCallableByName('name')).toEqual([]);
    });

    it('Property without declaredType is still added to fieldByOwner index only', () => {
      table.add('src/models.ts', 'name', 'prop:name', 'Property', { ownerId: 'class:User' });
      // No declaredType → still indexed in fieldByOwner (for write-access tracking
      // in dynamically-typed languages like Ruby/JS), but excluded from callable index
      expect(table.lookupCallableByName('name')).toEqual([]);
      expect(model.fields.lookupFieldByOwner('class:User', 'name')).toEqual({
        nodeId: 'prop:name',
        filePath: 'src/models.ts',
        type: 'Property',
        ownerId: 'class:User',
      });
    });

    it('post-A4: Method with ownerId lands in methodsByName, not callableByName', () => {
      // Plan 006 Unit 4 shrank FREE_CALLABLE_TYPES to free callables only.
      // Method registrations now flow through the method registry.
      table.add('src/models.ts', 'save', 'method:save', 'Method', { ownerId: 'class:User' });
      expect(table.lookupCallableByName('save')).toHaveLength(0);
      expect(model.methods.lookupMethodByName('save')).toHaveLength(1);
    });
  });

  describe('conditional callable index behaviour', () => {
    it('adding a Function makes it available in callable index', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function', { returnType: 'void' });
      expect(table.lookupCallableByName('foo')).toHaveLength(1);
      // Free Macro is a callable (C/C++ preprocessor macro).
      table.add('src/macros.h', 'BAR', 'macro:BAR', 'Macro');
      expect(table.lookupCallableByName('BAR')).toHaveLength(1);
    });

    it('adding a Property does NOT add it to callable index', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      expect(table.lookupCallableByName('foo')).toHaveLength(1);
      // Add a Property — callable index should still only contain foo
      table.add('src/models.ts', 'name', 'prop:name', 'Property', {
        declaredType: 'string',
        ownerId: 'class:User',
      });
      expect(table.lookupCallableByName('foo')).toHaveLength(1);
    });

    it('adding a Class does NOT add it to callable index', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      expect(table.lookupCallableByName('foo')).toHaveLength(1);
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      // Class is not callable, should not appear
      expect(table.lookupCallableByName('foo')).toHaveLength(1);
    });

    it('Macro (C/C++) is indexed in callable index', () => {
      table.add('src/macros.h', 'ASSERT', 'macro:ASSERT', 'Macro');
      expect(table.lookupCallableByName('ASSERT')).toHaveLength(1);
      expect(table.lookupCallableByName('ASSERT')[0].type).toBe('Macro');
    });

    it('Delegate (C#) is indexed in callable index', () => {
      table.add('src/Events.cs', 'OnClick', 'delegate:OnClick', 'Delegate');
      expect(table.lookupCallableByName('OnClick')).toHaveLength(1);
      expect(table.lookupCallableByName('OnClick')[0].type).toBe('Delegate');
    });

    it('Method WITHOUT ownerId falls back to the callable index', () => {
      // Orphaned Method (extractor contract violation / degraded AST).
      // The dispatch hook silently skips it because it has no owner to
      // key under; the callable-index fallback keeps it reachable at
      // Tier 3 global resolution.
      table.add('src/a.ts', 'orphan', 'method:orphan', 'Method');
      expect(table.lookupCallableByName('orphan')).toHaveLength(1);
      expect(table.lookupCallableByName('orphan')[0].type).toBe('Method');
    });

    it('Constructor WITHOUT ownerId falls back to the callable index', () => {
      table.add('src/a.ts', 'Orphan', 'ctor:Orphan', 'Constructor');
      expect(table.lookupCallableByName('Orphan')).toHaveLength(1);
      expect(table.lookupCallableByName('Orphan')[0].type).toBe('Constructor');
    });

    it('Method WITH ownerId does NOT land in the callable index (goes to MethodRegistry instead)', () => {
      table.add('src/user.ts', 'greet', 'method:User.greet', 'Method', {
        ownerId: 'class:User',
      });
      expect(table.lookupCallableByName('greet')).toHaveLength(0);
    });

    it('Constructor WITH ownerId does NOT land in the callable index', () => {
      table.add('src/user.ts', 'User', 'ctor:User', 'Constructor', {
        ownerId: 'class:User',
      });
      expect(table.lookupCallableByName('User')).toHaveLength(0);
    });

    it('Property WITHOUT ownerId still does NOT fall back to the callable index', () => {
      // Property fallback would pollute common names like `id` / `name` /
      // `type` — kept disjoint from the Method/Constructor fallback.
      table.add('src/a.ts', 'orphanField', 'prop:orphan', 'Property');
      expect(table.lookupCallableByName('orphanField')).toHaveLength(0);
    });
  });

  describe('lookupFieldByOwner', () => {
    it('finds a Property by ownerNodeId and fieldName', () => {
      table.add('src/models.ts', 'address', 'prop:address', 'Property', {
        declaredType: 'Address',
        ownerId: 'class:User',
      });
      const def = model.fields.lookupFieldByOwner('class:User', 'address');
      expect(def).toBeDefined();
      expect(def!.declaredType).toBe('Address');
      expect(def!.nodeId).toBe('prop:address');
    });

    it('returns undefined for unknown owner', () => {
      table.add('src/models.ts', 'address', 'prop:address', 'Property', {
        declaredType: 'Address',
        ownerId: 'class:User',
      });
      expect(model.fields.lookupFieldByOwner('class:Unknown', 'address')).toBeUndefined();
    });

    it('returns undefined for unknown field name', () => {
      table.add('src/models.ts', 'address', 'prop:address', 'Property', {
        declaredType: 'Address',
        ownerId: 'class:User',
      });
      expect(model.fields.lookupFieldByOwner('class:User', 'email')).toBeUndefined();
    });

    it('returns undefined for empty table', () => {
      expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
    });

    it('indexes Property without declaredType (for dynamic language write-access)', () => {
      table.add('src/models.ts', 'name', 'prop:name', 'Property', { ownerId: 'class:User' });
      expect(model.fields.lookupFieldByOwner('class:User', 'name')).toEqual({
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
      expect(model.fields.lookupFieldByOwner('class:User', 'name')!.declaredType).toBe('string');
      expect(model.fields.lookupFieldByOwner('class:Repo', 'name')!.declaredType).toBe('RepoName');
    });
  });

  describe('lookupMethodByOwner', () => {
    it('finds a Method by ownerNodeId and method name', () => {
      table.add('src/models.ts', 'getAddress', 'method:getAddress', 'Method', {
        returnType: 'Address',
        ownerId: 'class:User',
      });
      const def = model.methods.lookupMethodByOwner('class:User', 'getAddress');
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
      expect(model.methods.lookupMethodByOwner('class:User', 'getAddress')!.returnType).toBe(
        'Address',
      );
      expect(model.methods.lookupMethodByOwner('class:User', 'getName')!.returnType).toBe('String');
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
      expect(model.methods.lookupMethodByOwner('class:User', 'save')!.nodeId).toBe(
        'method:user:save',
      );
      expect(model.methods.lookupMethodByOwner('class:Address', 'save')!.nodeId).toBe(
        'method:address:save',
      );
    });

    it('returns undefined for unknown owner', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', {
        returnType: 'void',
        ownerId: 'class:User',
      });
      expect(model.methods.lookupMethodByOwner('class:Unknown', 'save')).toBeUndefined();
    });

    it('returns undefined for unknown method name', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', {
        returnType: 'void',
        ownerId: 'class:User',
      });
      expect(model.methods.lookupMethodByOwner('class:User', 'delete')).toBeUndefined();
    });

    it('returns undefined for empty table', () => {
      expect(model.methods.lookupMethodByOwner('class:User', 'save')).toBeUndefined();
    });

    it('Method without ownerId is not in MethodRegistry but falls back to callable index', () => {
      // methodHook silently skips Method-without-ownerId (methods.register
      // requires an owner). The orphan-owner-scoped fallback in
      // `SymbolTable.add()` routes such defs through `callableByName` so
      // Tier 3 global resolution can still find them.
      table.add('src/utils.ts', 'helper', 'method:helper', 'Method');
      expect(model.methods.lookupMethodByOwner('', 'helper')).toBeUndefined();
      expect(model.methods.lookupMethodByName('helper')).toHaveLength(0);
      expect(table.lookupCallableByName('helper')).toHaveLength(1);
      expect(table.lookupCallableByName('helper')[0].type).toBe('Method');
      expect(table.lookupExact('src/utils.ts', 'helper')).toBe('method:helper');
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
      const def = model.methods.lookupMethodByOwner('class:UserRepo', 'find');
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
      expect(model.methods.lookupMethodByOwner('class:Handler', 'process')).toBeUndefined();
    });

    it('indexes Constructor in methodByOwner', () => {
      table.add('src/models.ts', 'User', 'ctor:User', 'Constructor', {
        parameterCount: 0,
        ownerId: 'class:User',
      });
      expect(model.methods.lookupMethodByOwner('class:User', 'User')).toEqual({
        nodeId: 'ctor:User',
        filePath: 'src/models.ts',
        type: 'Constructor',
        parameterCount: 0,
        ownerId: 'class:User',
      });
      // Post-A4 Unit 4: Constructor no longer lands in callableByName.
      // It is reachable via methodsByName instead.
      expect(table.lookupCallableByName('User')).toHaveLength(0);
      expect(model.methods.lookupMethodByName('User')).toHaveLength(1);
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
      expect(model.methods.lookupMethodByOwner('class:Converter', 'convert')).toBeUndefined();
    });

    it('post-A4: Method with ownerId is reachable via methodsByName, not callableByName', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', {
        returnType: 'void',
        ownerId: 'class:User',
      });
      expect(table.lookupCallableByName('save')).toHaveLength(0);
      expect(model.methods.lookupMethodByName('save')).toHaveLength(1);
      expect(model.methods.lookupMethodByOwner('class:User', 'save')).toBeDefined();
    });

    it('after clear(), lookupMethodByOwner returns undefined', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', {
        returnType: 'void',
        ownerId: 'class:User',
      });
      expect(model.methods.lookupMethodByOwner('class:User', 'save')).toBeDefined();
      model.clear();
      expect(model.methods.lookupMethodByOwner('class:User', 'save')).toBeUndefined();
    });
  });

  describe('lookupCallableByName', () => {
    it('post-A4: returns only free callables (Function/Macro/Delegate)', () => {
      // Post-Unit 4, FREE_CALLABLE_TYPES = {Function, Macro, Delegate}.
      // Method and Constructor flow through the method registry instead.
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      table.add('src/a.ts', 'bar', 'method:bar', 'Method', { ownerId: 'class:X' });
      table.add('src/a.ts', 'Baz', 'ctor:Baz', 'Constructor', { ownerId: 'class:Baz' });
      table.add('src/a.ts', 'User', 'class:User', 'Class');
      table.add('src/a.ts', 'IUser', 'iface:IUser', 'Interface');
      expect(table.lookupCallableByName('foo')).toHaveLength(1);
      expect(table.lookupCallableByName('bar')).toEqual([]);
      expect(table.lookupCallableByName('Baz')).toEqual([]);
      expect(model.methods.lookupMethodByName('bar')).toHaveLength(1);
      expect(model.methods.lookupMethodByName('Baz')).toHaveLength(1);
      expect(table.lookupCallableByName('User')).toEqual([]);
      expect(table.lookupCallableByName('IUser')).toEqual([]);
    });

    it('returns empty array for unknown name', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      expect(table.lookupCallableByName('unknown')).toEqual([]);
    });

    it('includes newly added callable', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      expect(table.lookupCallableByName('foo')).toHaveLength(1);
      expect(table.lookupCallableByName('bar')).toEqual([]);
      table.add('src/a.ts', 'bar', 'func:bar', 'Function');
      expect(table.lookupCallableByName('bar')).toHaveLength(1);
    });

    it('filters non-callable types from mixed name entries', () => {
      table.add('src/a.ts', 'save', 'func:save', 'Function');
      table.add('src/b.ts', 'save', 'class:save', 'Class');
      const callables = table.lookupCallableByName('save');
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
      model.clear();
      expect(table.getStats()).toEqual({
        fileCount: 0,
      });
      expect(table.lookupExact('src/a.ts', 'foo')).toBeUndefined();
      expect(model.fields.lookupFieldByOwner('class:User', 'address')).toBeUndefined();
      expect(model.methods.lookupMethodByOwner('class:User', 'save')).toBeUndefined();
      expect(table.lookupCallableByName('foo')).toEqual([]);
      expect(model.types.lookupClassByName('User')).toEqual([]);
    });

    it('allows re-adding after clear', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      model.clear();
      table.add('src/b.ts', 'bar', 'func:bar', 'Function');
      expect(table.getStats()).toEqual({
        fileCount: 1,
      });
    });

    it('resets callable index so first lookup after clear rebuilds from scratch', () => {
      table.add('src/a.ts', 'foo', 'func:foo', 'Function');
      // Verify callable is found
      expect(table.lookupCallableByName('foo')).toHaveLength(1);
      model.clear();
      // After clear the callable index must be gone — empty table returns nothing
      expect(table.lookupCallableByName('foo')).toEqual([]);
      // Re-adding and looking up works correctly
      table.add('src/a.ts', 'foo', 'func:foo2', 'Function');
      expect(table.lookupCallableByName('foo')).toHaveLength(1);
      expect(table.lookupCallableByName('foo')[0].nodeId).toBe('func:foo2');
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

    it('stores only ownerId on a Method — reachable via methodsByName (post-A4)', () => {
      table.add('src/models.ts', 'save', 'method:save', 'Method', { ownerId: 'class:Repo' });
      const def = table.lookupExactFull('src/models.ts', 'save');
      expect(def).toBeDefined();
      expect(def!.ownerId).toBe('class:Repo');
      expect(def!.parameterCount).toBeUndefined();
      expect(def!.returnType).toBeUndefined();
      expect(def!.declaredType).toBeUndefined();
      // Post-A4 Unit 4: owner-scoped Method lives in methodsByName,
      // not callableByName.
      expect(table.lookupCallableByName('save')).toHaveLength(0);
      expect(model.methods.lookupMethodByName('save')).toHaveLength(1);
    });

    it('stores declaredType alone (no ownerId) — symbol in file index', () => {
      // A Variable/Property without an owner should still be accessible via file index
      table.add('src/config.ts', 'DEFAULT_TIMEOUT', 'var:DEFAULT_TIMEOUT', 'Variable', {
        declaredType: 'number',
      });
      const def = table.lookupExactFull('src/config.ts', 'DEFAULT_TIMEOUT');
      expect(def).toBeDefined();
      expect(def!.declaredType).toBe('number');
      expect(def!.ownerId).toBeUndefined();
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

  describe('lookupCallableByName — eager index behavior', () => {
    it('returns empty array when table has no callables', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      table.add('src/models.ts', 'IUser', 'iface:IUser', 'Interface');
      expect(table.lookupCallableByName('User')).toEqual([]);
      expect(table.lookupCallableByName('IUser')).toEqual([]);
    });

    it('returns consistent result on repeated calls', () => {
      table.add('src/a.ts', 'fetch', 'func:fetch', 'Function', { returnType: 'Response' });
      const first = table.lookupCallableByName('fetch');
      expect(first).toHaveLength(1);
      const second = table.lookupCallableByName('fetch');
      expect(second).toHaveLength(1);
      expect(second[0].nodeId).toBe('func:fetch');
    });

    it('post-A4: newly added Method is reachable via methodsByName, not callableByName', () => {
      table.add('src/a.ts', 'alpha', 'func:alpha', 'Function');
      expect(table.lookupCallableByName('alpha')).toHaveLength(1);
      expect(table.lookupCallableByName('beta')).toEqual([]);
      table.add('src/a.ts', 'beta', 'method:beta', 'Method', { ownerId: 'class:X' });
      expect(table.lookupCallableByName('beta')).toHaveLength(0);
      const byName = model.methods.lookupMethodByName('beta');
      expect(byName).toHaveLength(1);
      expect(byName[0].type).toBe('Method');
    });

    it('post-A4: newly added Constructor is reachable via methodsByName, not callableByName', () => {
      table.add('src/a.ts', 'existing', 'func:existing', 'Function');
      expect(table.lookupCallableByName('existing')).toHaveLength(1);
      table.add('src/models.ts', 'MyClass', 'ctor:MyClass', 'Constructor', {
        ownerId: 'class:MyClass',
      });
      expect(table.lookupCallableByName('MyClass')).toHaveLength(0);
      const byName = model.methods.lookupMethodByName('MyClass');
      expect(byName).toHaveLength(1);
      expect(byName[0].type).toBe('Constructor');
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
      expect(model.fields.lookupFieldByOwner('class:User', 'id')!.declaredType).toBe('number');
      expect(model.fields.lookupFieldByOwner('class:User', 'email')!.declaredType).toBe('string');
      expect(model.fields.lookupFieldByOwner('class:User', 'createdAt')!.declaredType).toBe('Date');
    });

    it('returns the full SymbolDefinition (nodeId + filePath + type) not just declaredType', () => {
      table.add('src/models.ts', 'score', 'prop:score', 'Property', {
        declaredType: 'number',
        ownerId: 'class:Player',
      });
      const def = model.fields.lookupFieldByOwner('class:Player', 'score');
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
      expect(model.fields.lookupFieldByOwner('class:A', 'id')!.nodeId).toBe('prop:a:id');
      expect(model.fields.lookupFieldByOwner('class:B', 'id')!.nodeId).toBe('prop:b:id');
      // An owner whose id is the concatenation of A's ownerId + fieldName must not match
      expect(model.fields.lookupFieldByOwner('class:A\0id', '')).toBeUndefined();
    });
  });

  describe('lookupClassByName', () => {
    it('returns Class definitions by name', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      const results = model.types.lookupClassByName('User');
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
      const results = model.types.lookupClassByName('Point');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('Struct');
    });

    it('returns Interface definitions by name', () => {
      table.add('src/types.ts', 'Serializable', 'iface:Serializable', 'Interface');
      const results = model.types.lookupClassByName('Serializable');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('Interface');
    });

    it('returns Enum definitions by name', () => {
      table.add('src/types.ts', 'Color', 'enum:Color', 'Enum');
      const results = model.types.lookupClassByName('Color');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('Enum');
    });

    it('returns Record definitions by name', () => {
      table.add('src/models.java', 'Config', 'record:Config', 'Record');
      const results = model.types.lookupClassByName('Config');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('Record');
    });

    it('does NOT include Function with the same name', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      table.add('src/utils.ts', 'User', 'func:User', 'Function');
      const results = model.types.lookupClassByName('User');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('Class');
      expect(results[0].nodeId).toBe('class:User');
    });

    it('does NOT include Method, Variable, Property, or Constructor', () => {
      table.add('src/a.ts', 'Foo', 'method:Foo', 'Method');
      table.add('src/a.ts', 'Bar', 'var:Bar', 'Variable');
      table.add('src/a.ts', 'Baz', 'prop:Baz', 'Property');
      table.add('src/a.ts', 'Qux', 'ctor:Qux', 'Constructor');
      expect(model.types.lookupClassByName('Foo')).toEqual([]);
      expect(model.types.lookupClassByName('Bar')).toEqual([]);
      expect(model.types.lookupClassByName('Baz')).toEqual([]);
      expect(model.types.lookupClassByName('Qux')).toEqual([]);
    });

    it('includes Trait in the class set (PHP use, Rust impl, Scala traits)', () => {
      // Traits are class-like for heritage resolution — they contribute
      // methods to the using/implementing type's hierarchy. The scope-resolution
      // pipeline relies on this to resolve `use Trait;` edges in PHP, `impl Trait
      // for Struct` in Rust, etc. Added as part of PR #744 (SM-11 Codex review
      // fixes) after the PHP HasTimestamps trait walk gap was discovered.
      table.add('src/a.rs', 'Writer', 'trait:Writer', 'Trait');
      const results = model.types.lookupClassByName('Writer');
      expect(results).toHaveLength(1);
      expect(results[0].nodeId).toBe('trait:Writer');
    });

    it('does NOT include other type-like labels outside the allowed class set', () => {
      table.add('src/a.ts', 'User', 'type:User', 'Type');
      expect(model.types.lookupClassByName('User')).toEqual([]);
    });

    it('returns multiple classes with the same name from different files', () => {
      table.add('src/models/user.ts', 'User', 'class:user:User', 'Class');
      table.add('src/dto/user.ts', 'User', 'class:dto:User', 'Class');
      const results = model.types.lookupClassByName('User');
      expect(results).toHaveLength(2);
      expect(results[0].filePath).toBe('src/models/user.ts');
      expect(results[1].filePath).toBe('src/dto/user.ts');
    });

    it('returns empty array for unknown name', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      expect(model.types.lookupClassByName('NonExistent')).toEqual([]);
    });

    it('returns empty array for empty table', () => {
      expect(model.types.lookupClassByName('User')).toEqual([]);
    });

    it('after clear(), returns empty array', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      expect(model.types.lookupClassByName('User')).toHaveLength(1);
      model.clear();
      expect(model.types.lookupClassByName('User')).toEqual([]);
    });

    it('returns mixed class-like types with the same name', () => {
      // e.g. a Class and an Interface both named 'Comparable' in different files
      table.add('src/base.ts', 'Comparable', 'class:Comparable', 'Class');
      table.add('src/types.ts', 'Comparable', 'iface:Comparable', 'Interface');
      const results = model.types.lookupClassByName('Comparable');
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.type)).toEqual(['Class', 'Interface']);
    });

    it('preserves metadata on indexed class definitions', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class', {
        returnType: 'User',
        ownerId: 'module:models',
      });
      const results = model.types.lookupClassByName('User');
      expect(results).toHaveLength(1);
      expect(results[0].ownerId).toBe('module:models');
    });

    it('class-like symbols are available via lookupClassByName', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      // classByName is the dedicated index for class-like lookups
      expect(model.types.lookupClassByName('User')).toHaveLength(1);
    });

    it('allows re-adding after clear and returns correct results', () => {
      table.add('src/models.ts', 'User', 'class:User:v1', 'Class');
      model.clear();
      table.add('src/models.ts', 'User', 'class:User:v2', 'Class');
      const results = model.types.lookupClassByName('User');
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

      expect(model.types.lookupClassByName('User')).toHaveLength(2);
      expect(model.types.lookupClassByQualifiedName('Services.User')).toEqual([
        {
          nodeId: 'class:services:User',
          filePath: 'src/services/user.cs',
          type: 'Class',
          qualifiedName: 'Services.User',
        },
      ]);
      const dataUserMatches = model.types.lookupClassByQualifiedName('Data.User');
      expect(dataUserMatches).toHaveLength(1);
      expect(dataUserMatches[0].qualifiedName).toBe('Data.User');
    });

    it('falls back to the simple name when no qualified metadata is provided', () => {
      table.add('src/models.ts', 'User', 'class:User', 'Class');
      expect(model.types.lookupClassByQualifiedName('User')).toEqual([
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
      expect(model.types.lookupClassByQualifiedName('Services.User')).toEqual([]);
    });

    it('after clear(), returns empty array', () => {
      table.add('src/services/user.cs', 'User', 'class:User', 'Class', {
        qualifiedName: 'Services.User',
      });
      expect(model.types.lookupClassByQualifiedName('Services.User')).toHaveLength(1);
      model.clear();
      expect(model.types.lookupClassByQualifiedName('Services.User')).toEqual([]);
    });
  });

  describe('SemanticModel container (SM-21 inversion)', () => {
    // Post-inversion, the SemanticModel is the top-level container and
    // SymbolTable is a nested `symbols` subfield. These tests exercise the
    // inverted access pattern directly via createSemanticModel() so the
    // factory wiring is covered end-to-end: feeding the symbol table via
    // its `add()` populates the parent registries (types/methods/fields).
    const buildModel = (): MutableSemanticModel => createSemanticModel();

    it('exposes types, methods, fields, and symbols subfields', () => {
      const model = buildModel();
      expect(model.types).toBeDefined();
      expect(model.methods).toBeDefined();
      expect(model.fields).toBeDefined();
      expect(model.symbols).toBeDefined();
    });

    it('feeding a Class via model.symbols.add populates model.types', () => {
      const model = buildModel();
      model.symbols.add('src/user.ts', 'User', 'class:User', 'Class', {
        qualifiedName: 'app.User',
      });
      expect(model.types.lookupClassByName('User')).toHaveLength(1);
      expect(model.types.lookupClassByName('User')[0]!.nodeId).toBe('class:User');
      expect(model.types.lookupClassByQualifiedName('app.User')).toHaveLength(1);
    });

    it('feeding a Method with ownerId populates model.methods', () => {
      const model = buildModel();
      model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
      model.symbols.add('src/user.ts', 'save', 'mtd:User.save', 'Method', {
        ownerId: 'class:User',
        parameterCount: 0,
      });
      expect(model.methods.lookupMethodByOwner('class:User', 'save')?.nodeId).toBe('mtd:User.save');
    });

    it('feeding a Property with ownerId populates model.fields', () => {
      const model = buildModel();
      model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
      model.symbols.add('src/user.ts', 'name', 'prop:User.name', 'Property', {
        ownerId: 'class:User',
        declaredType: 'string',
      });
      expect(model.fields.lookupFieldByOwner('class:User', 'name')?.nodeId).toBe('prop:User.name');
    });

    it('feeding an Impl populates model.types.lookupImplByName', () => {
      const model = buildModel();
      model.symbols.add('src/user.rs', 'User', 'impl:User', 'Impl');
      expect(model.types.lookupImplByName('User')).toHaveLength(1);
    });

    it('arity filtering disambiguates overloads via model.methods', () => {
      const model = buildModel();
      model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
      model.symbols.add('src/user.ts', 'greet', 'mtd:greet:0', 'Method', {
        ownerId: 'class:User',
        parameterCount: 0,
      });
      model.symbols.add('src/user.ts', 'greet', 'mtd:greet:1', 'Method', {
        ownerId: 'class:User',
        parameterCount: 1,
      });
      expect(model.methods.lookupMethodByOwner('class:User', 'greet', 0)?.nodeId).toBe(
        'mtd:greet:0',
      );
      expect(model.methods.lookupMethodByOwner('class:User', 'greet', 1)?.nodeId).toBe(
        'mtd:greet:1',
      );
    });

    it('clear() cascades through all three registries and the nested symbol table', () => {
      const model = buildModel();
      model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
      model.symbols.add('src/user.ts', 'save', 'mtd:User.save', 'Method', {
        ownerId: 'class:User',
      });
      model.symbols.add('src/user.ts', 'name', 'prop:User.name', 'Property', {
        ownerId: 'class:User',
        declaredType: 'string',
      });

      // Pre-clear: every store is populated.
      expect(model.types.lookupClassByName('User')).toHaveLength(1);
      expect(model.methods.lookupMethodByOwner('class:User', 'save')?.nodeId).toBe('mtd:User.save');
      expect(model.fields.lookupFieldByOwner('class:User', 'name')?.nodeId).toBe('prop:User.name');
      expect(model.symbols.lookupExact('src/user.ts', 'User')).toBe('class:User');

      model.clear();

      // Post-clear: every store is empty — types, methods, fields, symbols.
      expect(model.types.lookupClassByName('User')).toEqual([]);
      expect(model.methods.lookupMethodByOwner('class:User', 'save')).toBeUndefined();
      expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
      expect(model.symbols.lookupExact('src/user.ts', 'User')).toBeUndefined();
    });

    it('feeds Function-with-ownerId into model.methods (Python-style class method)', () => {
      // Python/Rust/Kotlin extractors emit class methods as `Function` with
      // ownerId. The add() branch must route these into the method registry
      // so owner-scoped resolution works uniformly across languages.
      const model = buildModel();
      model.symbols.add('src/user.py', 'User', 'class:User', 'Class');
      model.symbols.add('src/user.py', 'save', 'fn:User.save', 'Function', {
        ownerId: 'class:User',
      });
      expect(model.methods.lookupMethodByOwner('class:User', 'save')?.nodeId).toBe('fn:User.save');
    });

    it('silently skips Property without ownerId (no model.fields registration)', () => {
      // Properties without ownerId are kept in the file index but never
      // reach the fields registry — documenting the intentional behavior.
      const model = buildModel();
      model.symbols.add('src/user.ts', 'name', 'prop:orphan.name', 'Property', {
        declaredType: 'string',
      });
      expect(model.symbols.lookupExact('src/user.ts', 'name')).toBe('prop:orphan.name');
      expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // SM-22 — dispatch table routing invariants
  // -------------------------------------------------------------------------

  describe('registration dispatch table (SM-22)', () => {
    it('registering a Class hits types.registerClass exactly once and touches no other registry', () => {
      const model = createSemanticModel();
      const classSpy = vi.spyOn(model.types, 'registerClass');
      const implSpy = vi.spyOn(model.types, 'registerImpl');
      const methodsSpy = vi.spyOn(model.methods, 'register');
      const fieldsSpy = vi.spyOn(model.fields, 'register');

      model.symbols.add('src/user.ts', 'User', 'class:User', 'Class', {
        qualifiedName: 'app.User',
      });

      expect(classSpy).toHaveBeenCalledTimes(1);
      expect(implSpy).not.toHaveBeenCalled();
      expect(methodsSpy).not.toHaveBeenCalled();
      expect(fieldsSpy).not.toHaveBeenCalled();
    });

    it('registering a Property populates fields.register and DOES NOT append to callableByName', () => {
      const model = createSemanticModel();
      model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
      model.symbols.add('src/user.ts', 'name', 'prop:User.name', 'Property', {
        ownerId: 'class:User',
        declaredType: 'string',
      });

      expect(model.fields.lookupFieldByOwner('class:User', 'name')?.nodeId).toBe('prop:User.name');
      // Property must NOT leak into callableByName — Property is not in
      // FREE_CALLABLE_TYPES, so SymbolTable.add() never appends it.
      expect(model.symbols.lookupCallableByName('name')).toHaveLength(0);
    });

    it('registering a free Function populates callableByName but not methods.register', () => {
      const model = createSemanticModel();
      const methodsSpy = vi.spyOn(model.methods, 'register');

      model.symbols.add('src/utils.ts', 'format', 'fn:format', 'Function');

      expect(model.symbols.lookupCallableByName('format')).toHaveLength(1);
      expect(methodsSpy).not.toHaveBeenCalled();
    });

    it('registering a Function-with-ownerId routes to methods.register via pre-dispatch normalization AND appears in callableByName', () => {
      const model = createSemanticModel();
      model.symbols.add('src/user.py', 'User', 'class:User', 'Class');
      model.symbols.add('src/user.py', 'save', 'fn:User.save', 'Function', {
        ownerId: 'class:User',
      });

      // Owner-scoped method lookup resolves it (Python-style class method).
      expect(model.methods.lookupMethodByOwner('class:User', 'save')?.nodeId).toBe('fn:User.save');
      // Function is in FREE_CALLABLE_TYPES, so it also appears in callableByName.
      expect(model.symbols.lookupCallableByName('save')).toHaveLength(1);
    });

    it('registering an Impl populates lookupImplByName but NOT lookupClassByName', () => {
      const model = createSemanticModel();
      model.symbols.add('src/user.rs', 'User', 'impl:User', 'Impl');
      // Impl is kept separate from class-like so heritage resolution
      // does not treat it as a parent type candidate.
      expect(model.types.lookupImplByName('User')).toHaveLength(1);
      expect(model.types.lookupClassByName('User')).toHaveLength(0);
    });

    it('registering an inert NodeLabel only populates the file index', () => {
      const model = createSemanticModel();
      const classSpy = vi.spyOn(model.types, 'registerClass');
      const implSpy = vi.spyOn(model.types, 'registerImpl');
      const methodsSpy = vi.spyOn(model.methods, 'register');
      const fieldsSpy = vi.spyOn(model.fields, 'register');

      // `Variable` is in INERT_LABELS — no specialized registry, no
      // callable index (it's not in FREE_CALLABLE_TYPES).
      model.symbols.add('src/main.ts', 'CONFIG', 'var:CONFIG', 'Variable');

      expect(model.symbols.lookupExact('src/main.ts', 'CONFIG')).toBe('var:CONFIG');
      expect(classSpy).not.toHaveBeenCalled();
      expect(implSpy).not.toHaveBeenCalled();
      expect(methodsSpy).not.toHaveBeenCalled();
      expect(fieldsSpy).not.toHaveBeenCalled();
      expect(model.symbols.lookupCallableByName('CONFIG')).toHaveLength(0);
    });

    it('Method-without-ownerId skips methods.register and falls back to the callable index', () => {
      const model = createSemanticModel();
      const methodsSpy = vi.spyOn(model.methods, 'register');

      model.symbols.add('src/orphan.ts', 'orphan', 'mtd:orphan', 'Method');

      // File index still populated.
      expect(model.symbols.lookupExact('src/orphan.ts', 'orphan')).toBe('mtd:orphan');
      // Method registry NOT populated (no ownerId to key under) — the
      // dispatch hook silently skips.
      expect(methodsSpy).not.toHaveBeenCalled();
      expect(model.methods.lookupMethodByName('orphan')).toHaveLength(0);
      // Callable-index fallback: an orphaned Method/Constructor is an
      // extractor contract violation (AST-degraded parse), but we keep
      // it reachable at Tier 3 global resolution by routing it through
      // `callableByName`. Matches pre-dispatch-table behavior.
      expect(model.symbols.lookupCallableByName('orphan')).toHaveLength(1);
      expect(model.symbols.lookupCallableByName('orphan')[0].type).toBe('Method');
    });

    it('exhaustiveness guard does not fire for the current NodeLabel taxonomy', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Fresh SymbolTable — triggers the guard at construction.
      createSemanticModel();
      // No warnings about missing NodeLabels — every label is accounted
      // for in one of the three allowlists.
      const mismatchWarnings = warnSpy.mock.calls.filter((args) =>
        String(args[0]).startsWith('[SymbolTable] NodeLabel '),
      );
      expect(mismatchWarnings).toHaveLength(0);
      warnSpy.mockRestore();
    });
  });
});
