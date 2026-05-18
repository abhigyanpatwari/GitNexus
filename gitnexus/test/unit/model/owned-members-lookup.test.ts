/**
 * Step 2 owner-keyed lookup — correctness and perf contract (PR #1656).
 */

import { describe, it, expect } from 'vitest';
import type { DefIndex, SymbolDefinition } from 'gitnexus-shared';
import {
  buildFieldRegistry,
  buildMethodRegistry,
  EvidenceWeights,
  buildScopeTree,
  buildQualifiedNameIndex,
  buildModuleScopeIndex,
  buildMethodDispatchIndex,
  type RegistryContext,
  type Scope,
  type ScopeId,
  type TypeRef,
} from 'gitnexus-shared';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { lookupOwnedMembersByOwner } from '../../../src/core/ingestion/model/owned-members-lookup.js';

const mkDef = (overrides: Partial<SymbolDefinition> & { nodeId: string }): SymbolDefinition => ({
  nodeId: overrides.nodeId,
  filePath: overrides.filePath ?? 'x.ts',
  type: overrides.type ?? 'Class',
  ...overrides,
});

const typeRef = (rawName: string, declaredAtScope: ScopeId): TypeRef => ({
  rawName,
  declaredAtScope,
  source: 'parameter-annotation',
});

describe('lookupOwnedMembersByOwner', () => {
  it('returns methods only, fields only, or both without allocating on single-hit paths', () => {
    const model = createSemanticModel();
    const save = mkDef({
      nodeId: 'def:User.save',
      type: 'Method',
      qualifiedName: 'User.save',
      ownerId: 'def:User',
    });
    const name = mkDef({
      nodeId: 'def:User.name',
      type: 'Property',
      qualifiedName: 'User.name',
      ownerId: 'def:User',
    });
    model.methods.register('def:User', 'save', save);
    model.fields.register('def:User', 'name', name);

    const methodsOnly = lookupOwnedMembersByOwner(model, 'def:User', 'save');
    expect(methodsOnly).toEqual([save]);

    const fieldsOnly = lookupOwnedMembersByOwner(model, 'def:User', 'name');
    expect(fieldsOnly).toEqual([name]);

    const both = lookupOwnedMembersByOwner(model, 'def:User', 'save');
    expect(both).toEqual([save]);
  });

  it('merges method and field hits under the same (owner, name)', () => {
    const model = createSemanticModel();
    const prop = mkDef({
      nodeId: 'prop:User.id',
      type: 'Property',
      qualifiedName: 'User.id',
      ownerId: 'def:User',
    });
    const variable = mkDef({
      nodeId: 'def:User.id',
      type: 'Variable',
      qualifiedName: 'User.id',
      ownerId: 'def:User',
    });
    model.fields.register('def:User', 'id', prop);
    model.fields.register('def:User', 'id', variable);

    expect(lookupOwnedMembersByOwner(model, 'def:User', 'id')).toEqual([prop, variable]);
  });

  it('returns nested-type hits when registered under (owner, simpleName)', () => {
    const model = createSemanticModel();
    const inner = mkDef({
      nodeId: 'def:Outer.Inner',
      type: 'Class',
      qualifiedName: 'Outer.Inner',
      ownerId: 'def:Outer',
    });
    model.types.registerByOwner('def:Outer', 'Inner', inner);

    expect(lookupOwnedMembersByOwner(model, 'def:Outer', 'Inner')).toEqual([inner]);
  });

  it('merges methods + fields + nested-type hits under the same (owner, name)', () => {
    const model = createSemanticModel();
    const method = mkDef({
      nodeId: 'def:Outer.x#method',
      type: 'Method',
      qualifiedName: 'Outer.x',
      ownerId: 'def:Outer',
    });
    const field = mkDef({
      nodeId: 'def:Outer.x#field',
      type: 'Property',
      qualifiedName: 'Outer.x',
      ownerId: 'def:Outer',
    });
    const nested = mkDef({
      nodeId: 'def:Outer.x#class',
      type: 'Class',
      qualifiedName: 'Outer.x',
      ownerId: 'def:Outer',
    });
    model.methods.register('def:Outer', 'x', method);
    model.fields.register('def:Outer', 'x', field);
    model.types.registerByOwner('def:Outer', 'x', nested);

    expect(lookupOwnedMembersByOwner(model, 'def:Outer', 'x')).toEqual([method, field, nested]);
  });
});

describe('Step 2 perf contract', () => {
  it('does not scan defs.byId when ownedMembersByOwner is wired', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class', qualifiedName: 'User' });
    const saveMethod = mkDef({
      nodeId: 'def:User.save',
      type: 'Method',
      qualifiedName: 'User.save',
      ownerId: 'def:User',
    });
    const trapById = new Map<string, SymbolDefinition>([
      [userClass.nodeId, userClass],
      [saveMethod.nodeId, saveMethod],
    ]);
    trapById.values = () => {
      throw new Error('defs.byId.values() must not run when ownedMembersByOwner is provided');
    };

    const defs: DefIndex = {
      byId: trapById,
      size: trapById.size,
      get: (id) => trapById.get(id),
      has: (id) => trapById.has(id),
    };

    const callScope: Scope = {
      id: 'scope:call',
      parent: null,
      kind: 'Module',
      range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
      filePath: 'x.ts',
      bindings: new Map(),
      ownedDefs: [],
      imports: [],
      typeBindings: new Map([['user', typeRef('User', 'scope:call')]]),
    };

    const model = createSemanticModel();
    model.methods.register('def:User', 'save', saveMethod);

    const ctx: RegistryContext = {
      scopes: buildScopeTree([callScope]),
      defs,
      qualifiedNames: buildQualifiedNameIndex([userClass, saveMethod]),
      moduleScopes: buildModuleScopeIndex([]),
      methodDispatch: buildMethodDispatchIndex({
        owners: ['def:User'],
        computeMro: () => [],
        implementsOf: () => [],
      }),
      ownedMembersByOwner: (ownerDefId, memberName) =>
        lookupOwnedMembersByOwner(model, ownerDefId, memberName),
      providers: {},
    };

    const results = buildMethodRegistry(ctx).lookup('save', 'scope:call', {
      explicitReceiver: { name: 'user' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(saveMethod);
    expect(results[0]!.evidence.find((e) => e.kind === 'type-binding')?.weight).toBe(
      EvidenceWeights.typeBindingByMroDepth[0],
    );
  });

  it('does not scan defs.byId for implicit-self receiver (no explicitReceiver)', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class', qualifiedName: 'User' });
    const saveMethod = mkDef({
      nodeId: 'def:User.save',
      type: 'Method',
      qualifiedName: 'User.save',
      ownerId: 'def:User',
    });
    const trapById = new Map<string, SymbolDefinition>([
      [userClass.nodeId, userClass],
      [saveMethod.nodeId, saveMethod],
    ]);
    trapById.values = () => {
      throw new Error('defs.byId.values() must not run when ownedMembersByOwner is provided');
    };

    const defs: DefIndex = {
      byId: trapById,
      size: trapById.size,
      get: (id) => trapById.get(id),
      has: (id) => trapById.has(id),
    };

    const moduleScope: Scope = {
      id: 'scope:module',
      parent: null,
      kind: 'Module',
      range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
      filePath: 'x.ts',
      bindings: new Map(),
      ownedDefs: [],
      imports: [],
      typeBindings: new Map(),
    };
    const callScope: Scope = {
      id: 'scope:method-body',
      parent: 'scope:module',
      kind: 'Method',
      range: { startLine: 2, startCol: 0, endLine: 99, endCol: 0 },
      filePath: 'x.ts',
      bindings: new Map(),
      ownedDefs: [],
      imports: [],
      typeBindings: new Map([['self', typeRef('User', 'scope:method-body')]]),
    };

    const model = createSemanticModel();
    model.methods.register('def:User', 'save', saveMethod);

    const ctx: RegistryContext = {
      scopes: buildScopeTree([moduleScope, callScope]),
      defs,
      qualifiedNames: buildQualifiedNameIndex([userClass, saveMethod]),
      moduleScopes: buildModuleScopeIndex([moduleScope]),
      methodDispatch: buildMethodDispatchIndex({
        owners: ['def:User'],
        computeMro: () => [],
        implementsOf: () => [],
      }),
      ownedMembersByOwner: (ownerDefId, memberName) =>
        lookupOwnedMembersByOwner(model, ownerDefId, memberName),
      providers: {},
    };

    const results = buildMethodRegistry(ctx).lookup('save', 'scope:method-body', {
      explicitReceiver: { name: 'self' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(saveMethod);
  });

  it('does not scan defs.byId when walking a 2-level MRO chain', () => {
    const parentClass = mkDef({ nodeId: 'def:Parent', type: 'Class', qualifiedName: 'Parent' });
    const childClass = mkDef({ nodeId: 'def:Child', type: 'Class', qualifiedName: 'Child' });
    const parentSave = mkDef({
      nodeId: 'def:Parent.save',
      type: 'Method',
      qualifiedName: 'Parent.save',
      ownerId: 'def:Parent',
    });
    const trapById = new Map<string, SymbolDefinition>([
      [parentClass.nodeId, parentClass],
      [childClass.nodeId, childClass],
      [parentSave.nodeId, parentSave],
    ]);
    trapById.values = () => {
      throw new Error('defs.byId.values() must not run when ownedMembersByOwner is provided');
    };

    const defs: DefIndex = {
      byId: trapById,
      size: trapById.size,
      get: (id) => trapById.get(id),
      has: (id) => trapById.has(id),
    };

    const callScope: Scope = {
      id: 'scope:call',
      parent: null,
      kind: 'Module',
      range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
      filePath: 'x.ts',
      bindings: new Map(),
      ownedDefs: [],
      imports: [],
      typeBindings: new Map([['c', typeRef('Child', 'scope:call')]]),
    };

    const model = createSemanticModel();
    model.methods.register('def:Parent', 'save', parentSave);

    const ctx: RegistryContext = {
      scopes: buildScopeTree([callScope]),
      defs,
      qualifiedNames: buildQualifiedNameIndex([parentClass, childClass, parentSave]),
      moduleScopes: buildModuleScopeIndex([]),
      methodDispatch: buildMethodDispatchIndex({
        owners: ['def:Child', 'def:Parent'],
        computeMro: (id) => (id === 'def:Child' ? ['def:Parent'] : []),
        implementsOf: () => [],
      }),
      ownedMembersByOwner: (ownerDefId, memberName) =>
        lookupOwnedMembersByOwner(model, ownerDefId, memberName),
      providers: {},
    };

    const results = buildMethodRegistry(ctx).lookup('save', 'scope:call', {
      explicitReceiver: { name: 'c' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(parentSave);
    expect(results[0]!.evidence.find((e) => e.kind === 'type-binding')?.weight).toBe(
      EvidenceWeights.typeBindingByMroDepth[1],
    );
  });

  it('does not scan defs.byId for FieldRegistry reads via Step 2', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class', qualifiedName: 'User' });
    const nameField = mkDef({
      nodeId: 'def:User.name',
      type: 'Property',
      qualifiedName: 'User.name',
      ownerId: 'def:User',
    });
    const trapById = new Map<string, SymbolDefinition>([
      [userClass.nodeId, userClass],
      [nameField.nodeId, nameField],
    ]);
    trapById.values = () => {
      throw new Error('defs.byId.values() must not run when ownedMembersByOwner is provided');
    };

    const defs: DefIndex = {
      byId: trapById,
      size: trapById.size,
      get: (id) => trapById.get(id),
      has: (id) => trapById.has(id),
    };

    const callScope: Scope = {
      id: 'scope:call',
      parent: null,
      kind: 'Module',
      range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
      filePath: 'x.ts',
      bindings: new Map(),
      ownedDefs: [],
      imports: [],
      typeBindings: new Map([['user', typeRef('User', 'scope:call')]]),
    };

    const model = createSemanticModel();
    model.fields.register('def:User', 'name', nameField);

    const ctx: RegistryContext = {
      scopes: buildScopeTree([callScope]),
      defs,
      qualifiedNames: buildQualifiedNameIndex([userClass, nameField]),
      moduleScopes: buildModuleScopeIndex([]),
      methodDispatch: buildMethodDispatchIndex({
        owners: ['def:User'],
        computeMro: () => [],
        implementsOf: () => [],
      }),
      ownedMembersByOwner: (ownerDefId, memberName) =>
        lookupOwnedMembersByOwner(model, ownerDefId, memberName),
      providers: {},
    };

    const results = buildFieldRegistry(ctx).lookup('name', 'scope:call', {
      explicitReceiver: { name: 'user' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(nameField);
  });
});
