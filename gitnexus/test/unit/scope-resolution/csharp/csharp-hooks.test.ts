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
import { csharpMergeBindings } from '../../../../src/core/ingestion/languages/csharp/merge-bindings.js';
import { csharpArityCompatibility } from '../../../../src/core/ingestion/languages/csharp/arity.js';
import type {
  BindingRef,
  Callsite,
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeTree,
  SymbolDefinition,
  TypeRef,
} from 'gitnexus-shared';

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

describe('csharpMergeBindings — shadowing precedence', () => {
  const def = (nodeId: string): SymbolDefinition =>
    ({ nodeId, filePath: 't.cs', type: 'Function' }) as SymbolDefinition;
  const binding = (origin: BindingRef['origin'], nodeId: string): BindingRef =>
    ({ def: def(nodeId), origin }) as BindingRef;

  it('local declaration shadows `using` import', () => {
    const local = binding('local', 'L');
    const imp = binding('import', 'I');
    expect(csharpMergeBindings([imp, local])).toEqual([local]);
  });

  it('explicit `using` shadows `using static` (wildcard)', () => {
    const imp = binding('import', 'I');
    const wc = binding('wildcard', 'W');
    expect(csharpMergeBindings([wc, imp])).toEqual([imp]);
  });

  it('local shadows both `using` and `using static`', () => {
    const local = binding('local', 'L');
    const imp = binding('import', 'I');
    const wc = binding('wildcard', 'W');
    expect(csharpMergeBindings([wc, imp, local])).toEqual([local]);
  });

  it('keeps overload siblings at the same tier', () => {
    const a = binding('local', 'A');
    const b = binding('local', 'B');
    expect(csharpMergeBindings([a, b])).toEqual([a, b]);
  });

  it('dedupes same-nodeId bindings', () => {
    const a = binding('local', 'A');
    const a2 = binding('local', 'A');
    expect(csharpMergeBindings([a, a2])).toHaveLength(1);
  });

  it('namespace and reexport tie with explicit import (same tier)', () => {
    const ns = binding('namespace', 'N');
    const re = binding('reexport', 'R');
    const imp = binding('import', 'I');
    expect(csharpMergeBindings([ns, re, imp])).toHaveLength(3);
  });

  it('empty in → empty out', () => {
    expect(csharpMergeBindings([])).toEqual([]);
  });
});

describe('csharpArityCompatibility', () => {
  const callsite = (arity: number): Callsite => ({ arity });
  const def = (o: Partial<SymbolDefinition> = {}): SymbolDefinition =>
    ({ nodeId: 'd1', filePath: 't.cs', type: 'Function', ...o }) as SymbolDefinition;

  it('unknown when both parameter counts are missing', () => {
    expect(csharpArityCompatibility(def(), callsite(2))).toBe('unknown');
  });

  it('compatible inside [required, total]', () => {
    expect(
      csharpArityCompatibility(def({ parameterCount: 3, requiredParameterCount: 1 }), callsite(2)),
    ).toBe('compatible');
  });

  it('incompatible below required', () => {
    expect(
      csharpArityCompatibility(def({ parameterCount: 3, requiredParameterCount: 2 }), callsite(1)),
    ).toBe('incompatible');
  });

  it('incompatible above max without variadic', () => {
    expect(
      csharpArityCompatibility(def({ parameterCount: 2, requiredParameterCount: 0 }), callsite(5)),
    ).toBe('incompatible');
  });

  it('compatible above declared params when def has `params` variadic', () => {
    expect(
      csharpArityCompatibility(
        def({ parameterCount: undefined, requiredParameterCount: 0, parameterTypes: ['params'] }),
        callsite(7),
      ),
    ).toBe('compatible');
  });

  it('compatible above declared params when variadic token prefixes', () => {
    expect(
      csharpArityCompatibility(
        def({
          parameterCount: undefined,
          requiredParameterCount: 1,
          parameterTypes: ['string', 'params int[]'],
        }),
        callsite(4),
      ),
    ).toBe('compatible');
  });

  it('unknown for negative arity (defensive)', () => {
    expect(
      csharpArityCompatibility(def({ parameterCount: 3, requiredParameterCount: 1 }), callsite(-1)),
    ).toBe('unknown');
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
