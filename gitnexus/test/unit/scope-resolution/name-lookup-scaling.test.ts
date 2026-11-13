import { describe, expect, it } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  createEagerImportVisibility,
  type BindingRef,
  type ImportEdge,
  type Scope,
  type ScopeId,
} from 'gitnexus-shared';
import { resolveReferenceSites } from '../../../src/core/ingestion/resolve-references.js';
import { resolveCallerGraphId } from '../../../src/core/ingestion/scope-resolution/graph-bridge/ids.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { withCachedNameLookups } from '../../../src/core/ingestion/scope-resolution/scope/name-lookup-cache.js';
import { lookupNameClaim } from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';

function fixture(depth: number) {
  const scopes: Scope[] = Array.from({ length: depth + 1 }, (_, i) => ({
    id: `scope${i}`,
    parent: i === 0 ? null : `scope${i - 1}`,
    kind: i === 0 ? 'Module' : 'Function',
    filePath: 'test.dart',
    range: { startLine: i, startCol: 0, endLine: depth * 2 - i, endCol: 1 },
    ownedDefs: [],
    bindings: new Map(),
    typeBindings: new Map(),
    imports: [],
    lexicalNames: new Set(i === 0 ? ['items'] : ['x']),
  }));
  const byId = new Map(scopes.map((scope) => [scope.id, scope]));
  const imports = new Map<ScopeId, readonly ImportEdge[]>();
  let reads = 0;
  const indexes = {
    scopeTree: {
      size: byId.size,
      byId,
      getScope(id: ScopeId) {
        reads++;
        return byId.get(id);
      },
      getChildren(id: ScopeId) {
        const next = Number(id.slice('scope'.length)) + 1;
        return next <= depth ? [`scope${next}`] : [];
      },
    },
    bindings: new Map(),
    imports: createEagerImportVisibility(imports),
    bindingAugmentations: new Map(),
    workspaceFqnBindings: new Map(),
  } as unknown as ScopeResolutionIndexes;
  return { scopes, indexes, imports, reads: () => reads };
}

interface BarrierCase {
  name: string;
  setup: (f: ReturnType<typeof fixture>, mid: Scope, binding: BindingRef, edge: ImportEdge) => void;
}

const BARRIERS: BarrierCase[] = [
  {
    name: 'lexical name',
    setup: (_f, mid) => Object.assign(mid, { lexicalNames: new Set(['items']) }),
  },
  {
    name: 'type binding',
    setup: (_f, mid) =>
      Object.assign(mid, { typeBindings: new Map([['items', { rawName: 'List' }]]) }),
  },
  {
    name: 'receiver ownership',
    setup: (_f, mid) => Object.assign(mid, { ownsReceivers: new Set(['items']) }),
  },
  {
    name: 'explicit claim',
    setup: (_f, mid) =>
      Object.assign(mid, { nameClaims: [{ name: 'items', kind: 'blocked', range: mid.range }] }),
  },
  {
    name: 'local binding',
    setup: (_f, mid, binding) => Object.assign(mid, { bindings: new Map([['items', [binding]]]) }),
  },
  {
    name: 'scope import',
    setup: (_f, mid, _binding, edge) => Object.assign(mid, { imports: [edge] }),
  },
  { name: 'finalized import', setup: (f, mid, _binding, edge) => f.imports.set(mid.id, [edge]) },
  {
    name: 'finalized binding',
    setup: (f, mid, binding) =>
      Object.assign(f.indexes, { bindings: new Map([[mid.id, new Map([['items', [binding]]])]]) }),
  },
  {
    name: 'augmentation',
    setup: (f, mid, binding) =>
      Object.assign(f.indexes, {
        bindingAugmentations: new Map([[mid.id, new Map([['items', [binding]]])]]),
      }),
  },
  {
    name: 'accessible namespace',
    setup: (f, mid, binding) =>
      Object.assign(f.indexes, {
        accessibleNamespacesByScope: new Map([[mid.id, ['Visible']]]),
        namespaceFqnBindings: new Map([['Visible', new Map([['items', [binding]]])]]),
      }),
  },
  {
    name: 'namespace tiers',
    setup: (f, mid, binding) =>
      Object.assign(f.indexes, {
        namespaceLookupTiersByScope: new Map([[mid.id, [['Visible']]]]),
        namespaceFqnBindings: new Map([['Visible', new Map([['items', [binding]]])]]),
      }),
  },
  {
    name: 'workspace binding',
    setup: (f, _mid, binding) =>
      Object.assign(f.indexes, { workspaceFqnBindings: new Map([['items', [binding]]]) }),
  },
  {
    name: 'skip-from-children policy',
    setup: (_f, mid, binding) =>
      Object.assign(mid, {
        bindings: new Map([['items', [binding]]]),
        lookupPolicy: { skipFromChildren: true },
      }),
  },
  {
    name: 'deferred parent policy',
    setup: (f, mid, binding) => {
      Object.assign(f.scopes[0]!, { bindings: new Map([['items', [binding]]]) });
      Object.assign(mid, { lookupPolicy: { deferParentActivation: true } });
    },
  },
  {
    name: 'object scope',
    setup: (_f, mid, binding) =>
      Object.assign(mid, { kind: 'Object', bindings: new Map([['items', [binding]]]) }),
  },
  {
    name: 'enclosing class',
    setup: (_f, mid, binding) =>
      Object.assign(mid, { kind: 'Class', bindings: new Map([['items', [binding]]]) }),
  },
];

describe('read-only name lookup navigation', () => {
  it('does not rescan every empty sibling closure for each call', () => {
    const measure = (count: number, cached: boolean) => {
      const f = fixture(count);
      Object.assign(f.scopes[0]!, {
        kind: 'Function',
        ownedDefs: [
          { nodeId: 'def:test.dart#0:0:Function:outer', filePath: 'test.dart', type: 'Function' },
        ],
      });
      const children = f.scopes.slice(1).map((scope) => scope.id);
      Object.assign(f.indexes.scopeTree, {
        getChildren: (id: ScopeId) => (id === 'scope0' ? children : []),
      });
      const read = () => {
        for (let i = 1; i <= count; i++) {
          expect(
            resolveCallerGraphId('scope0', f.indexes, new Map(), { startLine: i, startCol: 0 }),
          ).toBeUndefined();
        }
      };
      if (cached) withCachedNameLookups(f.indexes, read);
      else read();
      return f.reads();
    };
    expect(measure(96, false)).toBeGreaterThan(measure(24, false) * 10);
    expect(measure(96, true)).toBeLessThanOrEqual(measure(24, true) * 4);
  });

  it('keeps caller attribution linear through empty closure scopes', () => {
    const measure = (depth: number) => {
      const f = fixture(depth);
      withCachedNameLookups(f.indexes, () => {
        for (let i = depth; i > 0; i--) {
          expect(resolveCallerGraphId(`scope${i}`, f.indexes, new Map())).toBe('File:test.dart');
        }
      });
      return f.reads();
    };
    expect(measure(96)).toBeLessThanOrEqual(measure(24) * 4);
  });

  it('preserves position-dependent child callers and missing graph identities', () => {
    const f = fixture(8);
    Object.assign(f.scopes[5]!, {
      ownedDefs: [
        { nodeId: 'def:test.dart#5:0:Function:child', filePath: 'test.dart', type: 'Function' },
      ],
    });
    for (const startLine of [4, 5]) {
      const at = { startLine, startCol: 0 };
      const uncached = resolveCallerGraphId('scope4', f.indexes, new Map(), at);
      expect(
        withCachedNameLookups(f.indexes, () =>
          resolveCallerGraphId('scope4', f.indexes, new Map(), at),
        ),
      ).toBe(uncached);
      expect(uncached).toBe(startLine === 4 ? 'File:test.dart' : undefined);
    }
  });

  it('keeps the real reference pass linear for nested calls and reads', () => {
    const measure = (depth: number) => {
      const f = fixture(depth);
      Object.assign(f.indexes, {
        defs: buildDefIndex([]),
        qualifiedNames: buildQualifiedNameIndex([]),
        moduleScopes: buildModuleScopeIndex([{ filePath: 'test.dart', moduleScopeId: 'scope0' }]),
        methodDispatch: buildMethodDispatchIndex({
          owners: [],
          computeMro: () => [],
          implementsOf: () => [],
        }),
        referenceSites: f.scopes.slice(1).flatMap((scope) =>
          (['call', 'read'] as const).map((kind) => ({
            kind,
            name: 'items',
            inScope: scope.id,
            filePath: scope.filePath,
            atRange: scope.range,
          })),
        ),
      });
      const result = resolveReferenceSites({ scopes: f.indexes, ownedMembersByOwner: () => [] });
      // The outer untyped binder owns the name but cannot supply a target.
      expect(result.stats).toEqual({
        sitesProcessed: depth * 2,
        referencesEmitted: 0,
        unresolved: depth * 2,
      });
      return f.reads();
    };
    expect(measure(96)).toBeLessThanOrEqual(measure(24) * 4);
  });

  it('scales linearly when every nested closure reads an outer binder', () => {
    const measure = (depth: number, cache: boolean) => {
      const f = fixture(depth);
      const read = () => {
        for (let i = depth; i > 0; i--) {
          expect(lookupNameClaim(`scope${i}`, 'items', f.indexes).scope?.id).toBe('scope0');
        }
      };
      if (cache) withCachedNameLookups(f.indexes, read);
      else read();
      return f.reads();
    };
    expect(measure(96, false)).toBeGreaterThan(measure(24, false) * 10);
    expect(measure(96, true)).toBeLessThanOrEqual(measure(24, true) * 4);
  });

  it.each(BARRIERS)('preserves $name through cold and warm lookups', ({ setup }) => {
    const f = fixture(8);
    const mid = f.scopes[4]!;
    const binding: BindingRef = {
      def: { nodeId: 'value', filePath: mid.filePath, type: 'Function' as const },
      origin: 'local' as const,
      availableFrom: { startLine: 6, startCol: 0 },
    };
    setup(f, mid, binding, {
      localName: 'items',
      targetFile: 'other.dart',
      targetExportedName: 'items',
      kind: 'named',
    });
    const queries = [false, true].flatMap((skipEnclosingClasses) =>
      [2, 7].map((startLine) => ({ position: { startLine, startCol: 0 }, skipEnclosingClasses })),
    );
    const read = () =>
      queries.map((options) => lookupNameClaim('scope8', 'items', f.indexes, options));
    const expected = read();
    expect(withCachedNameLookups(f.indexes, () => [...read(), ...read()])).toEqual([
      ...expected,
      ...expected,
    ]);
  });

  it('keeps the nearest caller definition even when it has no graph identity', () => {
    const f = fixture(8);
    Object.assign(f.scopes[4]!, {
      ownedDefs: [{ nodeId: 'local', filePath: 'test.dart', type: 'Function' }],
    });
    expect(resolveCallerGraphId('scope8', f.indexes, new Map())).toBeUndefined();
    expect(
      withCachedNameLookups(f.indexes, () => resolveCallerGraphId('scope8', f.indexes, new Map())),
    ).toBeUndefined();
  });

  it('does not retain shortcuts between passes or on the mutable original', () => {
    const f = fixture(8);
    expect(
      withCachedNameLookups(f.indexes, () => lookupNameClaim('scope8', 'items', f.indexes)).scope
        ?.id,
    ).toBe('scope0');
    (f.scopes[4]!.lexicalNames as Set<string>).add('items');
    expect(lookupNameClaim('scope8', 'items', f.indexes).scope?.id).toBe('scope4');
    expect(
      withCachedNameLookups(f.indexes, () => lookupNameClaim('scope8', 'items', f.indexes)).scope
        ?.id,
    ).toBe('scope4');
  });

  it('discards shortcuts when a pass throws', () => {
    const f = fixture(8);
    expect(() =>
      withCachedNameLookups(f.indexes, () => {
        expect(lookupNameClaim('scope8', 'items', f.indexes).scope?.id).toBe('scope0');
        throw new Error('pass failed');
      }),
    ).toThrow('pass failed');
    (f.scopes[4]!.lexicalNames as Set<string>).add('items');
    expect(lookupNameClaim('scope8', 'items', f.indexes).scope?.id).toBe('scope4');
  });
});
