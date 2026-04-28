/**
 * Unit tests for TypeRegistry (SM-20).
 *
 * TypeRegistry owns three indexes: classByName (simple name → defs),
 * classByQualifiedName (FQN → defs), and implByName (Rust impl blocks).
 * All three use array values to support homonym classes across files
 * (e.g. two `User` classes in different packages) and Rust's multiple
 * impl blocks per type.
 */

import { describe, it, expect } from 'vitest';
import { createTypeRegistry } from '../../../src/core/ingestion/model/type-registry.js';
import type { SymbolDefinition } from 'gitnexus-shared';
import { makeDef as makeBaseDef } from './helpers.js';

const makeDef = (overrides: Partial<SymbolDefinition> = {}): SymbolDefinition =>
  makeBaseDef({ nodeId: 'class:test', type: 'Class', ...overrides });

describe('TypeRegistry — classByName lookup', () => {
  it('returns an empty array when the class is not registered', () => {
    const reg = createTypeRegistry();
    expect(reg.lookupClassByName('Nonexistent')).toEqual([]);
  });

  it('returns the def reference after register', () => {
    const reg = createTypeRegistry();
    const def = makeDef({ nodeId: 'class:User' });

    reg.registerClass('User', 'app.User', def);

    expect(reg.lookupClassByName('User')).toEqual([def]);
  });

  it('accumulates homonym classes across files — second register appends, does not clobber', () => {
    const reg = createTypeRegistry();
    const userApp = makeDef({ nodeId: 'class:app.User', filePath: 'src/app/user.ts' });
    const userAdmin = makeDef({ nodeId: 'class:admin.User', filePath: 'src/admin/user.ts' });

    reg.registerClass('User', 'app.User', userApp);
    reg.registerClass('User', 'admin.User', userAdmin);

    const result = reg.lookupClassByName('User');
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.nodeId)).toEqual(['class:app.User', 'class:admin.User']);
  });
});

describe('TypeRegistry — classByQualifiedName lookup', () => {
  it('returns empty when the FQN is not registered', () => {
    const reg = createTypeRegistry();
    expect(reg.lookupClassByQualifiedName('app.User')).toEqual([]);
  });

  it('returns the def after register', () => {
    const reg = createTypeRegistry();
    const def = makeDef({ nodeId: 'class:app.User' });

    reg.registerClass('User', 'app.User', def);

    expect(reg.lookupClassByQualifiedName('app.User')).toEqual([def]);
  });

  it('disambiguates homonym classes — same simple name, different FQNs resolve independently', () => {
    const reg = createTypeRegistry();
    const userApp = makeDef({ nodeId: 'class:app.User' });
    const userAdmin = makeDef({ nodeId: 'class:admin.User' });

    reg.registerClass('User', 'app.User', userApp);
    reg.registerClass('User', 'admin.User', userAdmin);

    // Simple name returns both; qualified lookups split cleanly.
    expect(reg.lookupClassByName('User')).toHaveLength(2);
    expect(reg.lookupClassByQualifiedName('app.User')).toEqual([userApp]);
    expect(reg.lookupClassByQualifiedName('admin.User')).toEqual([userAdmin]);
  });

  it('partial classes — two defs with the same FQN accumulate in both indexes', () => {
    // C#-style partial classes: same simple and qualified name in different
    // files. Both classByName and classByQualifiedName should return both.
    const reg = createTypeRegistry();
    const partialA = makeDef({ nodeId: 'class:User#a', filePath: 'src/User.Core.cs' });
    const partialB = makeDef({ nodeId: 'class:User#b', filePath: 'src/User.Api.cs' });

    reg.registerClass('User', 'app.User', partialA);
    reg.registerClass('User', 'app.User', partialB);

    expect(reg.lookupClassByName('User')).toHaveLength(2);
    expect(reg.lookupClassByQualifiedName('app.User')).toHaveLength(2);
  });
});

describe('TypeRegistry — implByName (Rust impl blocks)', () => {
  it('returns empty when no impls registered', () => {
    const reg = createTypeRegistry();
    expect(reg.lookupImplByName('User')).toEqual([]);
  });

  it('registerImpl stores Rust impl blocks separately from classes', () => {
    const reg = createTypeRegistry();
    const userClass = makeDef({ nodeId: 'class:User', type: 'Struct' });
    const userImpl = makeDef({ nodeId: 'impl:User', type: 'Impl' });

    reg.registerClass('User', 'crate::User', userClass);
    reg.registerImpl('User', userImpl);

    expect(reg.lookupClassByName('User')).toEqual([userClass]);
    expect(reg.lookupImplByName('User')).toEqual([userImpl]);
  });

  it('accumulates multiple impl blocks for the same type (Rust allows several)', () => {
    const reg = createTypeRegistry();
    const implA = makeDef({ nodeId: 'impl:User#inherent', type: 'Impl' });
    const implB = makeDef({ nodeId: 'impl:User#Display', type: 'Impl' });

    reg.registerImpl('User', implA);
    reg.registerImpl('User', implB);

    const impls = reg.lookupImplByName('User');
    expect(impls).toHaveLength(2);
    expect(impls.map((d) => d.nodeId)).toEqual(['impl:User#inherent', 'impl:User#Display']);
  });
});

describe('TypeRegistry — clear()', () => {
  it('empties all three indexes', () => {
    const reg = createTypeRegistry();
    reg.registerClass('User', 'app.User', makeDef());
    reg.registerImpl('User', makeDef({ type: 'Impl' }));

    reg.clear();

    expect(reg.lookupClassByName('User')).toEqual([]);
    expect(reg.lookupClassByQualifiedName('app.User')).toEqual([]);
    expect(reg.lookupImplByName('User')).toEqual([]);
  });

  it('allows re-registration after clear', () => {
    const reg = createTypeRegistry();
    reg.registerClass('User', 'app.User', makeDef({ nodeId: 'class:first' }));
    reg.clear();
    reg.registerClass('User', 'app.User', makeDef({ nodeId: 'class:second' }));

    expect(reg.lookupClassByName('User')).toHaveLength(1);
    expect(reg.lookupClassByName('User')[0].nodeId).toBe('class:second');
  });
});
