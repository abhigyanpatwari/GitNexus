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
import { populateCsharpNamespaceSiblings } from '../../../../src/core/ingestion/languages/csharp/namespace-siblings.js';
import type {
  BindingRef,
  Callsite,
  CaptureMatch,
  ParsedFile,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  SymbolDefinition,
  TypeRef,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';

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

describe('populateCsharpNamespaceSiblings', () => {
  const classDef = (nodeId: string, filePath: string, qualifiedName: string): SymbolDefinition =>
    ({ nodeId, filePath, qualifiedName, type: 'Class' }) as SymbolDefinition;

  const scope = (
    id: string,
    kind: Scope['kind'],
    filePath: string,
    parent: ScopeId | null = null,
    ownedDefs: readonly SymbolDefinition[] = [],
  ): Scope =>
    ({
      id: id as ScopeId,
      kind,
      parent,
      filePath,
      range: { startLine: 1, startColumn: 0, endLine: 10, endColumn: 0 },
      bindings: new Map(),
      imports: [],
      ownedDefs,
      typeBindings: new Map(),
    }) as unknown as Scope;

  it('routes named-namespace siblings to the per-namespace channel without touching frozen finalized bindings', () => {
    // Verifies the post-finalize binding contract for the C#
    // namespace-siblings hook (per ScopeResolver I8 + the channel docs on
    // `ScopeResolutionIndexes`):
    //   * `indexes.bindings` (the finalize output) stays frozen and its inner
    //     `BindingRef[]` arrays are NEVER mutated by the hook — proven here by
    //     passing a frozen bucket and asserting it survives unchanged.
    //   * Named-namespace cross-file siblings are routed ONCE into
    //     `indexes.namespaceFqnBindings[ns]` (the per-namespace channel,
    //     #1871), NOT copied per-scope into `bindingAugmentations`. The file's
    //     accessible namespaces are recorded in `accessibleNamespacesByScope`.
    //   * Walkers downstream (`lookupBindingsAt`) merge the layers
    //     transparently, gated by accessibility — covered by
    //     walkers-augmentations.test.ts.
    const existing = classDef('def:external.B', 'external.cs', 'Other.B');
    const sibling = classDef('def:b.B', 'b.cs', 'Demo.B');
    const moduleA = scope('scope:a:module', 'Module', 'a.cs');
    const moduleB = scope('scope:b:module', 'Module', 'b.cs');
    const classB = scope('scope:b:class', 'Class', 'b.cs', moduleB.id, [sibling]);
    const parsedFiles: ParsedFile[] = [
      {
        filePath: 'a.cs',
        moduleScope: moduleA.id,
        scopes: Object.freeze([moduleA]),
        parsedImports: Object.freeze([]),
        localDefs: Object.freeze([]),
        referenceSites: Object.freeze([]),
      } as ParsedFile,
      {
        filePath: 'b.cs',
        moduleScope: moduleB.id,
        scopes: Object.freeze([moduleB, classB]),
        parsedImports: Object.freeze([]),
        localDefs: Object.freeze([sibling]),
        referenceSites: Object.freeze([]),
      } as ParsedFile,
    ];
    const frozenBucket = Object.freeze([{ def: existing, origin: 'import' } as BindingRef]);
    const bindings = new Map<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>([
      [moduleA.id, new Map<string, readonly BindingRef[]>([['B', frozenBucket]])],
    ]);
    const bindingAugmentations = new Map<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>();
    const namespaceFqnBindings = new Map<string, Map<string, BindingRef[]>>();
    const accessibleNamespacesByScope = new Map<ScopeId, string[]>();

    populateCsharpNamespaceSiblings(
      parsedFiles,
      {
        bindings,
        bindingAugmentations,
        workspaceFqnBindings: new Map(),
        workspaceTypeBindings: new Map(),
        namespaceFqnBindings,
        namespaceTypeBindings: new Map(),
        accessibleNamespacesByScope,
      } as unknown as ScopeResolutionIndexes,
      {
        fileContents: new Map([
          ['a.cs', 'namespace Demo;\nclass A { }\n'],
          ['b.cs', 'namespace Demo;\nclass B { }\n'],
        ]),
      },
    );

    // Finalized channel untouched and still frozen.
    const finalized = bindings.get(moduleA.id)?.get('B') ?? [];
    expect(finalized).toBe(frozenBucket);
    expect(finalized.map((b) => b.def.nodeId)).toEqual(['def:external.B']);
    expect(Object.isFrozen(finalized)).toBe(true);

    // Sibling B routed into the per-namespace channel once (not per-scope).
    const nsBucket = namespaceFqnBindings.get('Demo')?.get('B') ?? [];
    expect(nsBucket.map((b) => b.def.nodeId)).toEqual(['def:b.B']);
    expect(Object.isFrozen(nsBucket)).toBe(false);
    expect(nsBucket[0]?.origin).toBe('namespace');

    // a.cs's accessible namespaces (its own `Demo`) are recorded for the gate.
    expect(accessibleNamespacesByScope.get(moduleA.id)).toContain('Demo');

    // The per-scope augmentation channel is NOT used for named siblings anymore.
    expect(bindingAugmentations.get(moduleA.id)?.get('B')).toBeUndefined();
  });

  it('scans (no re-parse) UTF-8-heavy cache-miss files before namespace sibling injection', () => {
    const sibling = classDef('def:b.B', 'b.cs', 'Demo.B');
    const moduleA = scope('scope:a:module', 'Module', 'a.cs');
    const moduleB = scope('scope:b:module', 'Module', 'b.cs');
    const classB = scope('scope:b:class', 'Class', 'b.cs', moduleB.id, [sibling]);
    const parsedFiles: ParsedFile[] = [
      {
        filePath: 'a.cs',
        moduleScope: moduleA.id,
        scopes: Object.freeze([moduleA]),
        parsedImports: Object.freeze([]),
        localDefs: Object.freeze([]),
        referenceSites: Object.freeze([]),
      } as ParsedFile,
      {
        filePath: 'b.cs',
        moduleScope: moduleB.id,
        scopes: Object.freeze([moduleB, classB]),
        parsedImports: Object.freeze([]),
        localDefs: Object.freeze([sibling]),
        referenceSites: Object.freeze([]),
      } as ParsedFile,
    ];
    const namespaceFqnBindings = new Map<string, Map<string, BindingRef[]>>();
    const padding = '漢'.repeat(190_000);

    populateCsharpNamespaceSiblings(
      parsedFiles,
      {
        bindings: new Map(),
        bindingAugmentations: new Map(),
        workspaceFqnBindings: new Map(),
        workspaceTypeBindings: new Map(),
        namespaceFqnBindings,
        namespaceTypeBindings: new Map(),
        accessibleNamespacesByScope: new Map(),
      } as unknown as ScopeResolutionIndexes,
      {
        fileContents: new Map([
          ['a.cs', `namespace Demo;\n// ${padding}\nclass A { }\n`],
          ['b.cs', `namespace Demo;\n// ${padding}\nclass B { }\n`],
        ]),
      },
    );

    expect(namespaceFqnBindings.get('Demo')?.get('B')?.[0]?.def.nodeId).toBe('def:b.B');
  });

  it('routes global-namespace types to workspaceFqnBindings, not per-scope augmentations (#1871 OOM guard)', () => {
    // Types declared with NO `namespace` (the global/default namespace) are
    // visible from every C# file, so the hook writes ONE workspace-level entry
    // per simple name instead of O(scopes x defs) per-scope augmentations —
    // the fix for the #1871 Unity-scale OOM. This pins both halves of that
    // contract: global types are reachable via `workspaceFqnBindings`, and the
    // per-scope augmentation channel stays empty for them.
    //
    // Note: the mock MUST supply `workspaceFqnBindings` — the global fast path
    // reads `indexes.workspaceFqnBindings` directly, so omitting it (as the
    // other tests in this suite do) would throw.
    const defA = classDef('def:a.A', 'a.cs', 'A'); // simple name => global namespace
    const defB = classDef('def:b.B', 'b.cs', 'B');
    const moduleA = scope('scope:a:module', 'Module', 'a.cs');
    const classA = scope('scope:a:class', 'Class', 'a.cs', moduleA.id, [defA]);
    const moduleB = scope('scope:b:module', 'Module', 'b.cs');
    const classB = scope('scope:b:class', 'Class', 'b.cs', moduleB.id, [defB]);
    const parsedFiles: ParsedFile[] = [
      {
        filePath: 'a.cs',
        moduleScope: moduleA.id,
        scopes: Object.freeze([moduleA, classA]),
        parsedImports: Object.freeze([]),
        localDefs: Object.freeze([defA]),
        referenceSites: Object.freeze([]),
      } as ParsedFile,
      {
        filePath: 'b.cs',
        moduleScope: moduleB.id,
        scopes: Object.freeze([moduleB, classB]),
        parsedImports: Object.freeze([]),
        localDefs: Object.freeze([defB]),
        referenceSites: Object.freeze([]),
      } as ParsedFile,
    ];
    const bindingAugmentations = new Map<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>();
    const workspaceFqnBindings = new Map<string, readonly BindingRef[]>();

    populateCsharpNamespaceSiblings(
      parsedFiles,
      {
        bindings: new Map(),
        bindingAugmentations,
        workspaceFqnBindings,
      } as unknown as ScopeResolutionIndexes,
      {
        fileContents: new Map([
          ['a.cs', 'class A { }\n'], // no `namespace` => global
          ['b.cs', 'class B { }\n'],
        ]),
      },
    );

    // Global types are reachable workspace-wide via simple-name keys.
    expect(workspaceFqnBindings.get('A')?.map((b) => b.def.nodeId)).toEqual(['def:a.A']);
    expect(workspaceFqnBindings.get('B')?.map((b) => b.def.nodeId)).toEqual(['def:b.B']);
    // O(D) invariant: one entry per unique simple name, never scopes x defs.
    expect(workspaceFqnBindings.size).toBe(2);
    // The whole point of the fast path: no per-scope augmentation explosion.
    expect(bindingAugmentations.size).toBe(0);
    // Workspace entries carry the cross-file `namespace` origin (so shadowing
    // precedence in lookupBindingsAt orders them after local/finalized).
    expect(workspaceFqnBindings.get('A')?.[0]?.origin).toBe('namespace');
  });

  it('keeps every declaration of a repeated global simple name (partial classes across files)', () => {
    // Two global-namespace files each declare `Foo` (a partial class split
    // across files => distinct nodeIds, same simple name). Both must survive
    // in the workspace channel — the fast path de-dups by nodeId, not by name,
    // so partial-class members from both files stay resolvable.
    const foo1 = classDef('def:foo1.Foo', 'foo1.cs', 'Foo');
    const foo2 = classDef('def:foo2.Foo', 'foo2.cs', 'Foo');
    const moduleA = scope('scope:foo1:module', 'Module', 'foo1.cs');
    const classA = scope('scope:foo1:class', 'Class', 'foo1.cs', moduleA.id, [foo1]);
    const moduleB = scope('scope:foo2:module', 'Module', 'foo2.cs');
    const classB = scope('scope:foo2:class', 'Class', 'foo2.cs', moduleB.id, [foo2]);
    const parsedFiles: ParsedFile[] = [
      {
        filePath: 'foo1.cs',
        moduleScope: moduleA.id,
        scopes: Object.freeze([moduleA, classA]),
        parsedImports: Object.freeze([]),
        localDefs: Object.freeze([foo1]),
        referenceSites: Object.freeze([]),
      } as ParsedFile,
      {
        filePath: 'foo2.cs',
        moduleScope: moduleB.id,
        scopes: Object.freeze([moduleB, classB]),
        parsedImports: Object.freeze([]),
        localDefs: Object.freeze([foo2]),
        referenceSites: Object.freeze([]),
      } as ParsedFile,
    ];
    const bindingAugmentations = new Map<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>();
    const workspaceFqnBindings = new Map<string, readonly BindingRef[]>();

    populateCsharpNamespaceSiblings(
      parsedFiles,
      {
        bindings: new Map(),
        bindingAugmentations,
        workspaceFqnBindings,
      } as unknown as ScopeResolutionIndexes,
      {
        fileContents: new Map([
          ['foo1.cs', 'class Foo { }\n'],
          ['foo2.cs', 'class Foo { }\n'],
        ]),
      },
    );

    // Both partial declarations are kept (de-dup is by nodeId, not name).
    expect(
      workspaceFqnBindings
        .get('Foo')
        ?.map((b) => b.def.nodeId)
        .sort(),
    ).toEqual(['def:foo1.Foo', 'def:foo2.Foo']);
    expect(bindingAugmentations.size).toBe(0);
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
