/**
 * Unit 3 coverage for C# simple hooks.
 *
 * Exercises the small-surface hooks that mirror Python's simple-hooks:
 * `bindingScopeFor`, `importOwningScope`, `receiverBinding`. Each hook
 * is tiny, but the tests pin the delegation semantics so refactors
 * don't silently re-route bindings.
 *
 * `isSuperReceiver` lives on the ScopeResolver contract (Unit 6) rather
 * than the LanguageProvider, so it isn't exercised here.
 */

import { describe, it, expect } from 'vitest';
import {
  csharpBindingScopeFor,
  csharpImportOwningScope,
  csharpReceiverBinding,
} from '../../../../src/core/ingestion/languages/csharp/simple-hooks.js';
import type { CaptureMatch, ParsedImport, Scope, ScopeTree, TypeRef } from 'gitnexus-shared';

function fakeScope(
  kind: Scope['kind'],
  id = 's1',
  typeBindings = new Map<string, TypeRef>(),
): Scope {
  return {
    id,
    kind,
    parentId: null,
    childrenIds: [],
    bindings: new Map(),
    typeBindings,
  } as unknown as Scope;
}

const fakeTree = {} as ScopeTree;
const fakeCapture = {} as CaptureMatch;
const fakeImport: ParsedImport = {
  kind: 'namespace',
  localName: 'System',
  importedName: 'System',
  targetRaw: 'System',
};

describe('csharpBindingScopeFor', () => {
  it('delegates to innermost for method-body declarations', () => {
    const fn = fakeScope('Function');
    expect(csharpBindingScopeFor(fakeCapture, fn, fakeTree)).toBe(null);
  });

  it('delegates to innermost for namespace-body class declarations', () => {
    const ns = fakeScope('Namespace');
    expect(csharpBindingScopeFor(fakeCapture, ns, fakeTree)).toBe(null);
  });
});

describe('csharpImportOwningScope', () => {
  it('binds `using` inside a namespace to the namespace scope', () => {
    const ns = fakeScope('Namespace', 'ns-1');
    expect(csharpImportOwningScope(fakeImport, ns, fakeTree)).toBe('ns-1');
  });

  it('delegates file-level `using` to the module default', () => {
    const mod = fakeScope('Module');
    expect(csharpImportOwningScope(fakeImport, mod, fakeTree)).toBe(null);
  });

  it('attaches `using` inside a function scope to that function', () => {
    // Not legal C# at the source level, but defensive — Unit 7 parity
    // gate flags any regression.
    const fn = fakeScope('Function', 'fn-1');
    expect(csharpImportOwningScope(fakeImport, fn, fakeTree)).toBe('fn-1');
  });
});

describe('csharpReceiverBinding', () => {
  it('returns the `this` type binding for an instance method scope', () => {
    const binding: TypeRef = { rawName: 'User', source: 'self' } as unknown as TypeRef;
    const fn = fakeScope('Function', 'm-1', new Map([['this', binding]]));
    expect(csharpReceiverBinding(fn)).toBe(binding);
  });

  it('falls back to `base` when `this` is absent', () => {
    const binding: TypeRef = { rawName: 'Parent', source: 'self' } as unknown as TypeRef;
    const fn = fakeScope('Function', 'm-1', new Map([['base', binding]]));
    expect(csharpReceiverBinding(fn)).toBe(binding);
  });

  it('returns null for a static method (no synthesized `this`/`base`)', () => {
    const fn = fakeScope('Function', 'm-1');
    expect(csharpReceiverBinding(fn)).toBe(null);
  });

  it('returns null for non-Function scopes', () => {
    expect(csharpReceiverBinding(fakeScope('Class'))).toBe(null);
    expect(csharpReceiverBinding(fakeScope('Module'))).toBe(null);
  });
});
