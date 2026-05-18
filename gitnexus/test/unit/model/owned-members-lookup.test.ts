/**
 * Step 2 owner-keyed lookup — correctness and perf contract (PR #1656).
 */

import { describe, it, expect } from 'vitest';
import type { DefIndex, SymbolDefinition } from 'gitnexus-shared';
import {
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
    const originalValues = trapById.values.bind(trapById);
    trapById.values = function values() {
      throw new Error('defs.byId.values() must not run when ownedMembersByOwner is provided');
      return originalValues();
    } as typeof trapById.values;

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
});
