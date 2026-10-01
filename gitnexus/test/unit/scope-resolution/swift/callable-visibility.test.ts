import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type Scope,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import { swiftIsCallableVisibleFromCaller } from '../../../../src/core/ingestion/languages/swift/callable-visibility.js';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';

const filePath = 'Service.swift';
const moduleRange = { startLine: 1, startCol: 0, endLine: 12, endCol: 0 };
const classRange = { startLine: 2, startCol: 0, endLine: 10, endCol: 0 };
const functionRange = { startLine: 5, startCol: 0, endLine: 8, endCol: 0 };

function scope(
  id: string,
  parent: string | null,
  kind: Scope['kind'],
  ownedDefs: SymbolDefinition[],
  range: Scope['range'],
): Scope {
  return {
    id,
    parent,
    kind,
    range,
    filePath,
    ownedDefs,
    bindings: new Map(),
    imports: [],
    typeBindings: new Map(),
  };
}

const classDef: SymbolDefinition = {
  nodeId: 'Service',
  filePath,
  type: 'Class',
  qualifiedName: 'Service',
};
const property: SymbolDefinition = {
  nodeId: 'Service.clock',
  filePath,
  type: 'Property',
  qualifiedName: 'Service.clock',
  ownerId: 'Service',
};
const method: SymbolDefinition = {
  nodeId: 'Service.refresh',
  filePath,
  type: 'Method',
  qualifiedName: 'Service.refresh',
  ownerId: 'Service',
};
const scopes = {
  scopeTree: buildScopeTree([
    scope('module', null, 'Module', [], moduleRange),
    scope('class', 'module', 'Class', [classDef, property], classRange),
    scope('function', 'class', 'Function', [method], functionRange),
  ]),
  methodDispatch: buildMethodDispatchIndex({
    owners: [classDef.nodeId],
    computeMro: () => [],
    implementsOf: () => [],
  }),
} as ScopeResolutionIndexes;

describe('Swift caller-side callable visibility', () => {
  it('rejects an unrelated same-name method shadowed by a stored property', () => {
    expect(
      swiftIsCallableVisibleFromCaller({
        candidate: {
          nodeId: 'Other.clock',
          filePath: 'Other.swift',
          type: 'Method',
          qualifiedName: 'Other.clock',
        },
        callerScope: 'function',
        scopes,
      }),
    ).toBe(false);
  });

  it('keeps differently named methods and unknown caller scopes eligible', () => {
    const candidate: SymbolDefinition = {
      nodeId: 'Other.run',
      filePath: 'Other.swift',
      type: 'Method',
      qualifiedName: 'Other.run',
    };
    expect(swiftIsCallableVisibleFromCaller({ candidate, callerScope: 'function', scopes })).toBe(
      true,
    );
    expect(
      swiftIsCallableVisibleFromCaller({
        candidate: { ...candidate, qualifiedName: 'Other.clock' },
      }),
    ).toBe(true);
  });

  it('rejects a decoy when a superclass owns the closure property', () => {
    const base: SymbolDefinition = {
      nodeId: 'BaseService',
      filePath,
      type: 'Class',
      qualifiedName: 'BaseService',
    };
    const derived: SymbolDefinition = {
      nodeId: 'DerivedService',
      filePath,
      type: 'Class',
      qualifiedName: 'DerivedService',
    };
    const inheritedProperty: SymbolDefinition = {
      nodeId: 'BaseService.clock',
      filePath,
      type: 'Property',
      qualifiedName: 'BaseService.clock',
      ownerId: base.nodeId,
    };
    const inheritedScopes = {
      scopeTree: buildScopeTree([
        scope('derivedModule', null, 'Module', [], moduleRange),
        scope('derivedClass', 'derivedModule', 'Class', [derived], classRange),
        scope('derivedFunction', 'derivedClass', 'Function', [method], functionRange),
      ]),
      defs: buildDefIndex([base, derived, inheritedProperty]),
      qualifiedNames: buildQualifiedNameIndex([base, derived, inheritedProperty]),
      methodDispatch: buildMethodDispatchIndex({
        owners: [derived.nodeId],
        computeMro: () => [base.nodeId],
        implementsOf: () => [],
      }),
    } as ScopeResolutionIndexes;
    expect(
      swiftIsCallableVisibleFromCaller({
        candidate: {
          nodeId: 'Other.clock',
          filePath: 'Other.swift',
          type: 'Method',
          qualifiedName: 'Other.clock',
        },
        callerScope: 'derivedFunction',
        scopes: inheritedScopes,
      }),
    ).toBe(false);
  });
});
