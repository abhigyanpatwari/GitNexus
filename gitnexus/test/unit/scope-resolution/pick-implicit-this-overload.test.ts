/**
 * Unit tests for `pickImplicitThisOverload` — the implicit-`this` free-call
 * resolver in `free-call-fallback.ts`.
 *
 * Codex PR #1497 review, finding 2: the previous implementation returned
 * `candidates[0]` after `narrowOverloadCandidates` regardless of how many
 * candidates survived narrowing. When two same-name methods on the same
 * class had identical arity and unknown argument types, narrowing left both
 * compatible and the resolver emitted a high-confidence CALLS edge whose
 * target depended on registration order. The fix tightens the picker to
 * require a UNIQUE post-narrowing candidate; otherwise the call is left
 * unresolved.
 *
 * These tests exercise the function via synthetic stubs — no fixtures, no
 * pipeline — because the failure shape (two same-arity overloads with
 * indistinguishable types) cannot be produced by a PHP integration fixture
 * (PHP forbids method overloading) and any C# fixture would entangle this
 * unit's contract with the wider C# resolver.
 */

import { describe, it, expect } from 'vitest';
import type { Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { pickImplicitThisOverload } from '../../../src/core/ingestion/scope-resolution/passes/free-call-fallback.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { WorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';

const CLASS_SCOPE_ID = 'scope:test.cs#1:1-100:1:Class' as ScopeId;
const CLASS_DEF_ID = 'def:test.cs:Foo';

const mkMethod = (overrides: Partial<SymbolDefinition> & { nodeId: string }): SymbolDefinition => ({
  nodeId: overrides.nodeId,
  filePath: 'x.cs',
  type: 'Method',
  ...overrides,
});

const mkClassScope = (): Scope =>
  ({
    id: CLASS_SCOPE_ID,
    parent: null,
    kind: 'Class',
    range: { startLine: 1, startCol: 1, endLine: 100, endCol: 1 },
    filePath: 'test.cs',
    bindings: new Map(),
    typeBindings: new Map(),
    ownedDefs: [],
  }) as unknown as Scope;

const mkScopes = (
  scope: Scope,
  mroByOwner: ReadonlyMap<string, readonly string[]> = new Map(),
): ScopeResolutionIndexes =>
  ({
    scopeTree: {
      getScope: (id: ScopeId) => (id === scope.id ? scope : undefined),
    },
    methodDispatch: {
      mroFor: (classDefId: string) => mroByOwner.get(classDefId) ?? [],
    },
  }) as unknown as ScopeResolutionIndexes;

const mkWorkspaceIndex = (
  mapping: ReadonlyMap<ScopeId, string>,
  classScopeByDefId: ReadonlyMap<string, Scope> = new Map(),
): WorkspaceResolutionIndex =>
  ({
    classScopeIdToDefId: mapping,
    classScopeByDefId,
  }) as unknown as WorkspaceResolutionIndex;

const mkModel = (
  overloadsByName: ReadonlyMap<string, readonly SymbolDefinition[]>,
  overloadsByOwnerAndName: ReadonlyMap<string, readonly SymbolDefinition[]> = new Map(),
): SemanticModel =>
  ({
    methods: {
      lookupAllByOwner: (classDefId: string, name: string) =>
        overloadsByOwnerAndName.get(`${classDefId}::${name}`) ??
        overloadsByName.get(name) ??
        ([] as readonly SymbolDefinition[]),
    },
  }) as unknown as SemanticModel;

describe('pickImplicitThisOverload — uniqueness guard (Codex #1497 finding 2)', () => {
  const site = {
    inScope: CLASS_SCOPE_ID,
    name: 'save',
    arity: 1,
    argumentTypes: undefined,
  };

  it('returns the sole overload when only one method exists on the owner', () => {
    const sole = mkMethod({ nodeId: 'm:1', parameterCount: 1, requiredParameterCount: 1 });
    const scopes = mkScopes(mkClassScope());
    const workspace = mkWorkspaceIndex(new Map([[CLASS_SCOPE_ID, CLASS_DEF_ID]]));
    const model = mkModel(new Map([['save', [sole]]]));

    const result = pickImplicitThisOverload(site, scopes, workspace, model);

    expect(result?.nodeId).toBe('m:1');
  });

  it('returns the single survivor when narrowing disambiguates by arity', () => {
    const save1 = mkMethod({ nodeId: 'm:1', parameterCount: 1, requiredParameterCount: 1 });
    const save2 = mkMethod({ nodeId: 'm:2', parameterCount: 2, requiredParameterCount: 2 });
    const scopes = mkScopes(mkClassScope());
    const workspace = mkWorkspaceIndex(new Map([[CLASS_SCOPE_ID, CLASS_DEF_ID]]));
    const model = mkModel(new Map([['save', [save1, save2]]]));

    // site.arity = 1 → only save1 survives narrowing.
    const result = pickImplicitThisOverload(site, scopes, workspace, model);

    expect(result?.nodeId).toBe('m:1');
  });

  it('returns undefined when narrowing leaves two compatible candidates (the bug)', () => {
    // Two same-arity, same-required-count overloads with no disambiguating
    // parameter-type info on either def. `narrowOverloadCandidates` keeps
    // both; pre-fix code returned `candidates[0]` (registration order);
    // post-fix code returns undefined.
    const save1 = mkMethod({ nodeId: 'm:1', parameterCount: 1, requiredParameterCount: 1 });
    const save2 = mkMethod({ nodeId: 'm:2', parameterCount: 1, requiredParameterCount: 1 });
    const scopes = mkScopes(mkClassScope());
    const workspace = mkWorkspaceIndex(new Map([[CLASS_SCOPE_ID, CLASS_DEF_ID]]));
    const model = mkModel(new Map([['save', [save1, save2]]]));

    const result = pickImplicitThisOverload(site, scopes, workspace, model);

    expect(result).toBeUndefined();
  });

  it('returns undefined when no method on the owner matches the call name', () => {
    const scopes = mkScopes(mkClassScope());
    const workspace = mkWorkspaceIndex(new Map([[CLASS_SCOPE_ID, CLASS_DEF_ID]]));
    const model = mkModel(new Map());

    const result = pickImplicitThisOverload(site, scopes, workspace, model);

    expect(result).toBeUndefined();
  });

  it('returns undefined when the call site is not inside a Class scope', () => {
    // Module-scope sites: no enclosing class, so the implicit-this picker
    // has nothing to pick from. Different from an empty-narrowing miss.
    const moduleScope = {
      id: 'scope:test.cs#1:1-100:1:Module' as ScopeId,
      parent: null,
      kind: 'Module',
      range: { startLine: 1, startCol: 1, endLine: 100, endCol: 1 },
      filePath: 'test.cs',
      bindings: new Map(),
      typeBindings: new Map(),
      ownedDefs: [],
    } as unknown as Scope;
    const scopes = mkScopes(moduleScope);
    const workspace = mkWorkspaceIndex(new Map());
    const model = mkModel(new Map());

    const result = pickImplicitThisOverload(
      { ...site, inScope: moduleScope.id },
      scopes,
      workspace,
      model,
    );

    expect(result).toBeUndefined();
  });
});

describe('pickImplicitThisOverload — inherited implicit-this', () => {
  const PROTO_A = 'def:P.swift:A';
  const PROTO_B = 'def:P.swift:B';
  const site0 = {
    inScope: CLASS_SCOPE_ID,
    name: 'foo',
    arity: 0,
    argumentTypes: undefined,
  };

  it('arity-narrows a singleton on the enclosing type instead of returning it blindly', () => {
    const oneArg = mkMethod({
      nodeId: 'm:own-1',
      parameterCount: 1,
      requiredParameterCount: 1,
    });
    const scopes = mkScopes(mkClassScope());
    const workspace = mkWorkspaceIndex(new Map([[CLASS_SCOPE_ID, CLASS_DEF_ID]]));
    const model = mkModel(new Map([['foo', [oneArg]]]));

    expect(pickImplicitThisOverload(site0, scopes, workspace, model)?.nodeId).toBeUndefined();
  });

  it('unions inherited owners and arity-narrows instead of taking the first MRO name hit', () => {
    const aFoo = mkMethod({
      nodeId: 'm:A.foo',
      ownerId: PROTO_A,
      parameterCount: 1,
      requiredParameterCount: 1,
    });
    const bFoo = mkMethod({
      nodeId: 'm:B.foo',
      ownerId: PROTO_B,
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const scopes = mkScopes(mkClassScope(), new Map([[CLASS_DEF_ID, [PROTO_A, PROTO_B]]]));
    const workspace = mkWorkspaceIndex(new Map([[CLASS_SCOPE_ID, CLASS_DEF_ID]]));
    const model = mkModel(
      new Map(),
      new Map([
        [`${CLASS_DEF_ID}::foo`, []],
        [`${PROTO_A}::foo`, [aFoo]],
        [`${PROTO_B}::foo`, [bFoo]],
      ]),
    );

    const result = pickImplicitThisOverload(site0, scopes, workspace, model, {
      implicitThisWalksMro: true,
    });
    expect(result?.nodeId).toBe('m:B.foo');
  });

  it('picks the nearest inherited override when two MRO ancestors share a signature', () => {
    const MID = 'def:Mid.swift:Mid';
    const GRAND = 'def:Grand.swift:Grand';
    const midFoo = mkMethod({
      nodeId: 'm:Mid.foo',
      ownerId: MID,
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const grandFoo = mkMethod({
      nodeId: 'm:Grand.foo',
      ownerId: GRAND,
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const scopes = mkScopes(mkClassScope(), new Map([[CLASS_DEF_ID, [MID, GRAND]]]));
    const workspace = mkWorkspaceIndex(new Map([[CLASS_SCOPE_ID, CLASS_DEF_ID]]));
    const model = mkModel(
      new Map(),
      new Map([
        [`${CLASS_DEF_ID}::foo`, []],
        [`${MID}::foo`, [midFoo]],
        [`${GRAND}::foo`, [grandFoo]],
      ]),
    );

    const result = pickImplicitThisOverload(site0, scopes, workspace, model, {
      implicitThisWalksMro: true,
    });
    expect(result?.nodeId).toBe('m:Mid.foo');
  });

  it('prefers a protocol-extension default over the protocol requirement of the same arity', () => {
    const requirement = mkMethod({
      nodeId: 'm:P.req',
      ownerId: PROTO_A,
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const body = mkMethod({
      nodeId: 'm:P.ext',
      ownerId: PROTO_A,
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const protocolScope = {
      id: 'scope:P.swift#1:1-20:1:Class' as ScopeId,
      parent: null,
      kind: 'Class',
      range: { startLine: 1, startCol: 1, endLine: 20, endCol: 1 },
      filePath: 'P.swift',
      bindings: new Map(),
      typeBindings: new Map(),
      ownedDefs: [
        {
          nodeId: PROTO_A,
          filePath: 'P.swift',
          type: 'Protocol',
          qualifiedName: 'A',
        } as SymbolDefinition,
        requirement,
      ],
    } as unknown as Scope;
    const scopes = mkScopes(mkClassScope(), new Map([[CLASS_DEF_ID, [PROTO_A]]]));
    const workspace = mkWorkspaceIndex(
      new Map([[CLASS_SCOPE_ID, CLASS_DEF_ID]]),
      new Map([[PROTO_A, protocolScope]]),
    );
    const model = mkModel(
      new Map(),
      new Map([
        [`${CLASS_DEF_ID}::foo`, []],
        [`${PROTO_A}::foo`, [requirement, body]],
      ]),
    );

    const result = pickImplicitThisOverload(site0, scopes, workspace, model, {
      implicitThisWalksMro: true,
    });
    expect(result?.nodeId).toBe('m:P.ext');
  });

  it('does not prefer a protocol-extension witness over an inherited class member', () => {
    const BASE = 'def:Base.swift:Base';
    const baseType = {
      nodeId: BASE,
      filePath: 'Base.swift',
      type: 'Class',
      qualifiedName: 'Base',
    } as SymbolDefinition;
    const baseFoo = mkMethod({
      nodeId: 'm:Base.foo',
      ownerId: BASE,
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const extFoo = mkMethod({
      nodeId: 'm:P.ext',
      ownerId: PROTO_A,
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const baseScope = {
      id: 'scope:Base.swift#1:1-20:1:Class' as ScopeId,
      parent: null,
      kind: 'Class',
      range: { startLine: 1, startCol: 1, endLine: 20, endCol: 1 },
      filePath: 'Base.swift',
      bindings: new Map(),
      typeBindings: new Map(),
      ownedDefs: [baseType, baseFoo],
    } as unknown as Scope;
    const protocolScope = {
      id: 'scope:P.swift#1:1-20:1:Class' as ScopeId,
      parent: null,
      kind: 'Class',
      range: { startLine: 1, startCol: 1, endLine: 20, endCol: 1 },
      filePath: 'P.swift',
      bindings: new Map(),
      typeBindings: new Map(),
      ownedDefs: [
        {
          nodeId: PROTO_A,
          filePath: 'P.swift',
          type: 'Protocol',
          qualifiedName: 'A',
        } as SymbolDefinition,
      ],
    } as unknown as Scope;
    const scopes = mkScopes(mkClassScope(), new Map([[CLASS_DEF_ID, [BASE, PROTO_A]]]));
    const workspace = mkWorkspaceIndex(
      new Map([[CLASS_SCOPE_ID, CLASS_DEF_ID]]),
      new Map([
        [BASE, baseScope],
        [PROTO_A, protocolScope],
      ]),
    );
    const model = mkModel(
      new Map(),
      new Map([
        [`${CLASS_DEF_ID}::foo`, []],
        [`${BASE}::foo`, [baseFoo]],
        [`${PROTO_A}::foo`, [extFoo]],
      ]),
    );

    const result = pickImplicitThisOverload(site0, scopes, workspace, model, {
      implicitThisWalksMro: true,
    });
    expect(result?.nodeId).toBe('m:Base.foo');
  });

  it('falls through to inherited when the enclosing type only has an arity-incompatible decoy', () => {
    const decoy = mkMethod({
      nodeId: 'm:own-decoy',
      ownerId: CLASS_DEF_ID,
      parameterCount: 1,
      requiredParameterCount: 1,
    });
    const inherited = mkMethod({
      nodeId: 'm:ext',
      ownerId: PROTO_A,
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const scopes = mkScopes(mkClassScope(), new Map([[CLASS_DEF_ID, [PROTO_A]]]));
    const workspace = mkWorkspaceIndex(new Map([[CLASS_SCOPE_ID, CLASS_DEF_ID]]));
    const model = mkModel(
      new Map(),
      new Map([
        [`${CLASS_DEF_ID}::foo`, [decoy]],
        [`${PROTO_A}::foo`, [inherited]],
      ]),
    );

    const result = pickImplicitThisOverload(site0, scopes, workspace, model, {
      implicitThisWalksMro: true,
    });
    expect(result?.nodeId).toBe('m:ext');
  });
});
