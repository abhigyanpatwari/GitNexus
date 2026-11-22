/**
 * DART-11 — the receiver TYPE walk stops at the nearest scope that binds the
 * receiver name, typed or not, and `findUntypedReceiverBinder` names that scope.
 *
 * `findReceiverTypeBinding` must not borrow an enclosing scope's type for a
 * name a nearer scope rebinds without a type, and must not fall through to the
 * namespace or workspace channels either: the nearer binder owns the name.
 */
import { describe, expect, it } from 'vitest';
import type { BindingRef, NameClaim, Scope, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import { createEagerImportVisibility } from 'gitnexus-shared';
import {
  findReceiverTypeBinding,
  findUntypedReceiverBinder,
} from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

const range = { startLine: 1, startCol: 0, endLine: 20, endCol: 0 };
const typed = (rawName: string, declaredAtScope: string): TypeRef => ({
  rawName,
  declaredAtScope,
  source: 'parameter-annotation',
});

function scope(id: string, parent: string | null, extra: Partial<Scope> = {}): Scope {
  return {
    id,
    parent,
    kind: parent === null ? 'Module' : 'Function',
    filePath: 'app.dart',
    range,
    bindings: new Map(),
    imports: [],
    ownedDefs: [],
    typeBindings: new Map(),
    ...extra,
  };
}

function indexes(
  scopes: readonly Scope[],
  workspaceTypeBindings?: ReadonlyMap<string, TypeRef>,
): ScopeResolutionIndexes {
  const byId = new Map(scopes.map((s) => [s.id, s]));
  return {
    scopeTree: {
      getScope: (id: string) => byId.get(id),
      getChildren: (id: string) => scopes.filter((s) => s.parent === id).map((s) => s.id),
      byId,
    },
    moduleScopes: { byFilePath: new Map([['app.dart', 'module']]) },
    bindings: new Map(),
    bindingAugmentations: new Map(),
    imports: createEagerImportVisibility(new Map()),
    workspaceTypeBindings,
  } as unknown as ScopeResolutionIndexes;
}

/** `Address cs` at module scope: the binding an enclosing walk would borrow. */
const moduleScope = scope('module', null, {
  typeBindings: new Map([['cs', typed('Address', 'module')]]),
});

describe('findReceiverTypeBinding — the nearest binder owns the receiver name', () => {
  it('control: with no nearer binder the walk reaches the enclosing typed binding', () => {
    const fn = scope('fn', 'module');
    expect(findReceiverTypeBinding('fn', 'cs', indexes([moduleScope, fn]))?.rawName).toBe(
      'Address',
    );
    expect(findUntypedReceiverBinder('fn', 'cs', indexes([moduleScope, fn]))).toBeUndefined();
  });

  it('an untyped lexical binder stops the walk before the enclosing typed binding', () => {
    const fn = scope('fn', 'module', { lexicalNames: new Set(['cs']) });
    expect(findReceiverTypeBinding('fn', 'cs', indexes([moduleScope, fn]))).toBeUndefined();
    expect(findUntypedReceiverBinder('fn', 'cs', indexes([moduleScope, fn]))?.id).toBe('fn');
  });

  it('the stop also skips the workspace fallback channel', () => {
    const fn = scope('fn', 'module', { lexicalNames: new Set(['cs']) });
    const bare = scope('module', null);
    const workspace = new Map([['cs', typed('Other', 'module')]]);
    // Control: without the binder, the flat workspace channel answers.
    expect(
      findReceiverTypeBinding('fn', 'cs', indexes([bare, scope('fn', 'module')], workspace))
        ?.rawName,
    ).toBe('Other');
    expect(findReceiverTypeBinding('fn', 'cs', indexes([bare, fn], workspace))).toBeUndefined();
  });

  it('the NEAREST binder wins: a closure stops at its own parameter, the function at its typed one', () => {
    const fn = scope('fn', 'module', {
      lexicalNames: new Set(['cs']),
      typeBindings: new Map([['cs', typed('Address', 'fn')]]),
    });
    const closure = scope('closure', 'fn', { lexicalNames: new Set(['cs']) });
    const all = indexes([scope('module', null), fn, closure]);
    expect(findReceiverTypeBinding('closure', 'cs', all)).toBeUndefined();
    expect(findUntypedReceiverBinder('closure', 'cs', all)?.id).toBe('closure');
    // A binder that also carries a type answers with it — not a stop.
    expect(findReceiverTypeBinding('fn', 'cs', all)?.rawName).toBe('Address');
    expect(findUntypedReceiverBinder('fn', 'cs', all)).toBeUndefined();
  });

  it('a closure that does not rebind the name is transparent', () => {
    const fn = scope('fn', 'module', {
      lexicalNames: new Set(['cs']),
      typeBindings: new Map([['cs', typed('Address', 'fn')]]),
    });
    const closure = scope('closure', 'fn', { lexicalNames: new Set(['x']) });
    const all = indexes([scope('module', null), fn, closure]);
    expect(findReceiverTypeBinding('closure', 'cs', all)?.rawName).toBe('Address');
    expect(findUntypedReceiverBinder('closure', 'cs', all)).toBeUndefined();
  });
});

describe('findUntypedReceiverBinder — only a bare lexical stop counts', () => {
  const value: SymbolDefinition = { nodeId: 'def:cs', filePath: 'app.dart', type: 'Variable' };
  const local: BindingRef = { def: value, origin: 'local' };

  it('a value binding at the stopping scope is an answer, not an untyped stop', () => {
    const fn = scope('fn', 'module', {
      lexicalNames: new Set(['cs']),
      bindings: new Map([['cs', [local]]]),
    });
    expect(findUntypedReceiverBinder('fn', 'cs', indexes([moduleScope, fn]))).toBeUndefined();
  });

  it('explicit name claims govern instead of lexical names', () => {
    const claim: NameClaim = {
      name: 'cs',
      kind: 'blocked',
      range: { startLine: 2, startCol: 0, endLine: 2, endCol: 2 },
    };
    const fn = scope('fn', 'module', {
      lexicalNames: new Set(['cs']),
      nameClaims: [claim],
    });
    expect(findReceiverTypeBinding('fn', 'cs', indexes([moduleScope, fn]))).toBeUndefined();
    expect(findUntypedReceiverBinder('fn', 'cs', indexes([moduleScope, fn]))).toBeUndefined();
  });
});
