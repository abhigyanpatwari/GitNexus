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

const mkScopes = (scope: Scope): ScopeResolutionIndexes =>
  ({
    scopeTree: {
      getScope: (id: ScopeId) => (id === scope.id ? scope : undefined),
    },
  }) as unknown as ScopeResolutionIndexes;

const mkWorkspaceIndex = (mapping: ReadonlyMap<ScopeId, string>): WorkspaceResolutionIndex =>
  ({
    classScopeIdToDefId: mapping,
  }) as unknown as WorkspaceResolutionIndex;

const mkModel = (
  overloadsByName: ReadonlyMap<string, readonly SymbolDefinition[]>,
): SemanticModel =>
  ({
    methods: {
      lookupAllByOwner: (_classDefId: string, name: string) =>
        overloadsByName.get(name) ?? ([] as readonly SymbolDefinition[]),
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
