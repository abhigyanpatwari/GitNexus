/**
 * Unit coverage for the scope-independent and per-namespace binding channels
 * consulted by the typeBindings / BindingRef walkers (#1871, building on #1954):
 *
 *   - `workspaceTypeBindings` — flat global typeBindings (the #1954 channel that
 *     previously had NO always-run coverage; only a gated benchmark exercised it).
 *   - `namespaceTypeBindings` / `namespaceFqnBindings` — per-namespace channels
 *     consulted ONLY for the namespaces in `accessibleNamespacesByScope` for the
 *     caller's module, so a named-namespace type does not leak to files that
 *     can't see it.
 *
 * These pin the precedence (local chain → named namespace → global) and the
 * accessibility gate directly at the walker level, independent of the C# hook
 * and the gated pipeline benchmark.
 */

import { describe, it, expect } from 'vitest';
import {
  findReceiverTypeBinding,
  lookupBindingsAt,
} from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import { followChainPostFinalize } from '../../../src/core/ingestion/scope-resolution/passes/imported-return-types.js';
import type {
  BindingRef,
  Scope,
  ScopeId,
  ScopeTree,
  SymbolDefinition,
  TypeRef,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

const MODULE = 'scope:m:module' as ScopeId;

const tref = (rawName: string): TypeRef => ({ rawName }) as unknown as TypeRef;
const bref = (nodeId: string): BindingRef =>
  ({
    def: { nodeId, filePath: 'm.cs', type: 'Class' } as SymbolDefinition,
    origin: 'namespace',
  }) as BindingRef;

/** A single Module scope with `parent: null`, plus the new channels. */
function indexes(opts: {
  moduleTypeBindings?: Map<string, TypeRef>;
  workspaceTypeBindings?: Map<string, TypeRef>;
  namespaceTypeBindings?: Map<string, Map<string, TypeRef>>;
  workspaceFqnBindings?: Map<string, readonly BindingRef[]>;
  namespaceFqnBindings?: Map<string, Map<string, readonly BindingRef[]>>;
  accessible?: string[];
  bindings?: Map<ScopeId, Map<string, readonly BindingRef[]>>;
  augmented?: Map<ScopeId, Map<string, readonly BindingRef[]>>;
}): ScopeResolutionIndexes {
  const moduleScope = {
    id: MODULE,
    kind: 'Module',
    parent: null,
    filePath: 'm.cs',
    range: { startLine: 1, startColumn: 0, endLine: 99, endColumn: 0 },
    bindings: new Map(),
    imports: [],
    ownedDefs: [],
    typeBindings: opts.moduleTypeBindings ?? new Map(),
  } as unknown as Scope;
  const accessibleNamespacesByScope = new Map<ScopeId, string[]>();
  if (opts.accessible !== undefined) accessibleNamespacesByScope.set(MODULE, opts.accessible);
  return {
    scopeTree: {
      getScope: (id: ScopeId) => (id === MODULE ? moduleScope : undefined),
    } as unknown as ScopeTree,
    bindings: opts.bindings ?? new Map(),
    bindingAugmentations: opts.augmented ?? new Map(),
    workspaceFqnBindings: opts.workspaceFqnBindings ?? new Map(),
    workspaceTypeBindings: opts.workspaceTypeBindings ?? new Map(),
    namespaceFqnBindings: opts.namespaceFqnBindings ?? new Map(),
    namespaceTypeBindings: opts.namespaceTypeBindings ?? new Map(),
    accessibleNamespacesByScope,
  } as unknown as ScopeResolutionIndexes;
}

describe('findReceiverTypeBinding — workspaceTypeBindings (global, #1954)', () => {
  it('resolves a global typeBinding when the scope chain misses', () => {
    const out = findReceiverTypeBinding(
      MODULE,
      'svc',
      indexes({ workspaceTypeBindings: new Map([['svc', tref('GlobalSvc')]]) }),
    );
    expect(out?.rawName).toBe('GlobalSvc');
  });

  it('a local chain typeBinding shadows the global channel', () => {
    const out = findReceiverTypeBinding(
      MODULE,
      'svc',
      indexes({
        moduleTypeBindings: new Map([['svc', tref('LocalSvc')]]),
        workspaceTypeBindings: new Map([['svc', tref('GlobalSvc')]]),
      }),
    );
    expect(out?.rawName).toBe('LocalSvc');
  });
});

describe('findReceiverTypeBinding — namespaceTypeBindings (named, gated)', () => {
  it('resolves a named-namespace typeBinding when that namespace is accessible', () => {
    const out = findReceiverTypeBinding(
      MODULE,
      'svc',
      indexes({
        accessible: ['App'],
        namespaceTypeBindings: new Map([['App', new Map([['svc', tref('AppSvc')]])]]),
      }),
    );
    expect(out?.rawName).toBe('AppSvc');
  });

  it('does NOT resolve a named type from a namespace the file cannot see (no leak)', () => {
    const out = findReceiverTypeBinding(
      MODULE,
      'svc',
      indexes({
        accessible: ['Other'], // file sees `Other`, not `App`
        namespaceTypeBindings: new Map([['App', new Map([['svc', tref('AppSvc')]])]]),
      }),
    );
    expect(out).toBeUndefined();
  });

  it('named namespace wins over global (more-specific precedence)', () => {
    const out = findReceiverTypeBinding(
      MODULE,
      'svc',
      indexes({
        accessible: ['App'],
        namespaceTypeBindings: new Map([['App', new Map([['svc', tref('AppSvc')]])]]),
        workspaceTypeBindings: new Map([['svc', tref('GlobalSvc')]]),
      }),
    );
    expect(out?.rawName).toBe('AppSvc');
  });
});

describe('lookupBindingsAt — namespaceFqnBindings (gated) + precedence', () => {
  it('includes per-namespace BindingRefs for an accessible namespace', () => {
    const out = lookupBindingsAt(
      MODULE,
      'User',
      indexes({
        accessible: ['App'],
        namespaceFqnBindings: new Map([['App', new Map([['User', [bref('def:App.User')]]])]]),
      }),
    );
    expect(out.map((b) => b.def.nodeId)).toEqual(['def:App.User']);
  });

  it('excludes per-namespace BindingRefs for an inaccessible namespace (no leak)', () => {
    const out = lookupBindingsAt(
      MODULE,
      'User',
      indexes({
        accessible: ['Other'],
        namespaceFqnBindings: new Map([['App', new Map([['User', [bref('def:App.User')]]])]]),
      }),
    );
    expect(out).toEqual([]);
  });

  it('merges in precedence order finalized > augmented > namespace > workspace', () => {
    const out = lookupBindingsAt(
      MODULE,
      'User',
      indexes({
        accessible: ['App'],
        bindings: new Map([[MODULE, new Map([['User', [bref('def:fin')]]])]]),
        augmented: new Map([[MODULE, new Map([['User', [bref('def:aug')]]])]]),
        namespaceFqnBindings: new Map([['App', new Map([['User', [bref('def:ns')]]])]]),
        workspaceFqnBindings: new Map([['User', [bref('def:ws')]]]),
      }),
    );
    expect(out.map((b) => b.def.nodeId)).toEqual(['def:fin', 'def:aug', 'def:ns', 'def:ws']);
  });
});

describe('followChainPostFinalize — per-namespace fallback', () => {
  it('follows a chain step through an accessible namespace typeBinding', () => {
    const out = followChainPostFinalize(
      tref('GetUser'),
      MODULE,
      indexes({
        accessible: ['App'],
        namespaceTypeBindings: new Map([['App', new Map([['GetUser', tref('User')]])]]),
      }),
    );
    expect(out.rawName).toBe('User');
  });

  it('terminates (no infinite loop) when the namespace ref points back to itself', () => {
    const self = tref('Loop');
    const out = followChainPostFinalize(
      self,
      MODULE,
      indexes({
        accessible: ['App'],
        namespaceTypeBindings: new Map([['App', new Map([['Loop', tref('Loop')]])]]),
      }),
    );
    expect(out.rawName).toBe('Loop');
  });
});
