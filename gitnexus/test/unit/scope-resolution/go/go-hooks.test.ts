import { describe, expect, it } from 'vitest';
import type {
  BindingRef,
  Callsite,
  ImportEdge,
  ParsedImport,
  ReferenceSite,
  Scope,
  ScopeId,
  SymbolDefinition,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';
import {
  goArityCompatibility,
  goMergeBindings,
  goReceiverBinding,
} from '../../../../src/core/ingestion/languages/go/index.js';
import { detectGoInterfaceImplementations } from '../../../../src/core/ingestion/languages/go/interface-impls.js';
import { populateGoOwners } from '../../../../src/core/ingestion/languages/go/method-owners.js';

describe('Go arity compatibility', () => {
  const makeDef = (overrides: Partial<SymbolDefinition> = {}): SymbolDefinition => ({
    nodeId: 'def:1',
    filePath: 'a.go',
    type: 'Function',
    qualifiedName: 'F',
    ...overrides,
  });

  it('returns unknown when no param count info', () => {
    const def = makeDef();
    const callsite: Callsite = {
      name: 'F',
      inScope: 's',
      atRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      kind: 'call',
      arity: 1,
    };
    expect(goArityCompatibility(def, callsite)).toBe('unknown');
  });

  it('exact match is compatible', () => {
    const def = makeDef({ parameterCount: 2, requiredParameterCount: 2 });
    const callsite: Callsite = {
      name: 'F',
      inScope: 's',
      atRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      kind: 'call',
      arity: 2,
    };
    expect(goArityCompatibility(def, callsite)).toBe('compatible');
  });

  it('too few args is incompatible', () => {
    const def = makeDef({ parameterCount: 2, requiredParameterCount: 2 });
    const callsite: Callsite = {
      name: 'F',
      inScope: 's',
      atRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      kind: 'call',
      arity: 1,
    };
    expect(goArityCompatibility(def, callsite)).toBe('incompatible');
  });

  it('variadic accepts extra args', () => {
    const def = makeDef({
      parameterCount: 2,
      requiredParameterCount: 1,
      parameterTypes: ['string', '...string'],
    });
    const callsite: Callsite = {
      name: 'F',
      inScope: 's',
      atRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      kind: 'call',
      arity: 5,
    };
    expect(goArityCompatibility(def, callsite)).toBe('compatible');
  });

  it('non-variadic rejects extra args', () => {
    const def = makeDef({ parameterCount: 2, requiredParameterCount: 2 });
    const callsite: Callsite = {
      name: 'F',
      inScope: 's',
      atRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      kind: 'call',
      arity: 3,
    };
    expect(goArityCompatibility(def, callsite)).toBe('incompatible');
  });
});

describe('Go merge bindings', () => {
  it('local wins over import', () => {
    const local: BindingRef = {
      origin: 'local',
      def: { nodeId: 'def:local', filePath: 'main.go', type: 'Function', qualifiedName: 'Save' },
    };
    const imported: BindingRef = {
      origin: 'import',
      def: { nodeId: 'def:import', filePath: 'util.go', type: 'Function', qualifiedName: 'Save' },
    };
    const merged = goMergeBindings([imported], [local], 'scope:1');
    expect(merged[0].def.nodeId).toBe('def:local');
  });

  it('deduplicates by DefId', () => {
    const a: BindingRef = {
      origin: 'local',
      def: { nodeId: 'def:1', filePath: 'a.go', type: 'Function', qualifiedName: 'F' },
    };
    const b: BindingRef = {
      origin: 'local',
      def: { nodeId: 'def:1', filePath: 'a.go', type: 'Function', qualifiedName: 'F' },
    };
    expect(goMergeBindings([], [a, b], 'scope:1').length).toBe(1);
  });
});

describe('Go receiver binding', () => {
  it('reads self type binding from function scope', () => {
    const scope = {
      kind: 'Function',
      typeBindings: new Map([
        ['u', { rawName: 'User', declaredAtScope: 'scope:1', source: 'self' }],
      ]),
    } as unknown as Scope;
    expect(goReceiverBinding(scope)?.rawName).toBe('User');
  });

  it('normalizes pointer self bindings for receiver lookup', () => {
    const scope = {
      kind: 'Function',
      typeBindings: new Map([
        ['u', { rawName: '*User', declaredAtScope: 'scope:1', source: 'self' }],
      ]),
    } as unknown as Scope;
    expect(goReceiverBinding(scope)?.rawName).toBe('User');
  });

  it('returns null for non-Function scope', () => {
    const scope = { kind: 'Module', typeBindings: new Map() } as unknown as Scope;
    expect(goReceiverBinding(scope)).toBeNull();
  });

  it('returns null when no self binding', () => {
    const scope = { kind: 'Function', typeBindings: new Map() } as unknown as Scope;
    expect(goReceiverBinding(scope)).toBeNull();
  });
});

function goDef(
  nodeId: string,
  type: SymbolDefinition['type'],
  qualifiedName: string,
  ownerId?: string,
  metadata: Partial<SymbolDefinition> = {},
): SymbolDefinition {
  return {
    nodeId,
    filePath: 'repo.go',
    type,
    qualifiedName,
    ...(ownerId === undefined ? {} : { ownerId }),
    ...metadata,
  };
}

function parsedGoDefs(
  defs: readonly SymbolDefinition[],
  options: {
    readonly scopes?: readonly Scope[];
    readonly referenceSites?: readonly ReferenceSite[];
    readonly parsedImports?: readonly ParsedImport[];
  } = {},
) {
  return [parsedGoFile('repo.go', defs, options)] as any;
}

/** `import <local> "<path>"` as the extractor records it (#2873). */
function goNamespaceImport(localName: string, targetRaw: string): ParsedImport {
  return {
    kind: 'namespace',
    localName,
    importedName: targetRaw.slice(targetRaw.lastIndexOf('/') + 1),
    targetRaw,
  };
}

function parsedGoFile(
  filePath: string,
  defs: readonly SymbolDefinition[],
  options: {
    readonly scopes?: readonly Scope[];
    readonly referenceSites?: readonly ReferenceSite[];
    readonly parsedImports?: readonly ParsedImport[];
    readonly moduleScope?: ScopeId;
  } = {},
) {
  return {
    filePath,
    language: 'go',
    scopes: options.scopes ?? [],
    imports: [],
    parsedImports: options.parsedImports ?? [],
    ...(options.moduleScope === undefined ? {} : { moduleScope: options.moduleScope }),
    localDefs: [...defs],
    referenceSites: options.referenceSites ?? [],
  } as any;
}

function scopeIndexes(
  defs: readonly SymbolDefinition[],
  scopes: readonly Scope[] = [],
  options: {
    readonly bindingAugmentations?: ReadonlyMap<
      ScopeId,
      ReadonlyMap<string, readonly BindingRef[]>
    >;
    readonly imports?: ReadonlyMap<ScopeId, readonly ImportEdge[]>;
  } = {},
): ScopeResolutionIndexes {
  const defsById = new Map(defs.map((def) => [def.nodeId, def]));
  const qualifiedNames = new Map<string, string[]>();
  for (const def of defs) {
    const ids = qualifiedNames.get(def.qualifiedName) ?? [];
    ids.push(def.nodeId);
    qualifiedNames.set(def.qualifiedName, ids);
  }
  const scopesById = new Map(scopes.map((s) => [s.id, s]));
  return {
    defs: { get: (id: string) => defsById.get(id) },
    qualifiedNames: { get: (name: string) => qualifiedNames.get(name) ?? [] },
    scopeTree: { getScope: (id: ScopeId) => scopesById.get(id) },
    bindings: new Map(),
    bindingAugmentations: options.bindingAugmentations ?? new Map(),
    imports: options.imports ?? new Map(),
    workspaceFqnBindings: new Map(),
    namespaceFqnBindings: new Map(),
    accessibleNamespacesByScope: new Map(),
    methodDispatch: {} as any,
    moduleScopes: {} as any,
    workspaceTypeBindings: new Map(),
    namespaceTypeBindings: new Map(),
    referenceSites: [],
    sccs: [],
    stats: {} as any,
  } as ScopeResolutionIndexes;
}

const emptyIndexes = scopeIndexes([]);

function scope(
  id: ScopeId,
  kind: Scope['kind'],
  ownedDefs: readonly SymbolDefinition[],
  parent: ScopeId | null = null,
): Scope {
  return {
    id,
    parent,
    kind,
    filePath: 'repo.go',
    range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
    bindings: new Map(),
    ownedDefs,
    imports: [],
    typeBindings: new Map(),
  };
}

function inheritsSite(name: string, inScope: ScopeId): ReferenceSite {
  return {
    name,
    inScope,
    kind: 'inherits',
    atRange: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
  };
}

/**
 * Structural detection now returns the receiver FORM alongside each
 * implementor (`{ structDefId, receiverForm }`), because Go's method sets for
 * `T` and `*T` genuinely differ. Most rows below only care about WHICH types
 * implement, so this extracts the ids; the rows that care about the form assert
 * it explicitly.
 */
function implIds(
  result: Map<string, readonly { readonly structDefId: string }[]>,
  ifaceId: string,
): string[] | undefined {
  const found = result.get(ifaceId);
  // Deliberately NOT sorted: several rows below assert detection ORDER
  // (shallowest-promoted-first), which sorting would silently destroy.
  return found === undefined ? undefined : found.map((i) => i.structDefId);
}

describe('Go structural interface detection', () => {
  it('detects a struct implementing every interface method with matching signatures', () => {
    const iface = goDef('iface:Repository', 'Interface', 'Repository');
    const struct = goDef('struct:SqlRepository', 'Struct', 'SqlRepository');
    const ifaceFind = goDef('iface:Repository.Find', 'Method', 'Repository.Find', iface.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['string'],
      returnType: 'User',
    });
    const ifaceSave = goDef('iface:Repository.Save', 'Method', 'Repository.Save', iface.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['User'],
      returnType: 'error',
    });
    const structFind = goDef(
      'struct:SqlRepository.Find',
      'Method',
      'SqlRepository.Find',
      struct.nodeId,
      {
        parameterCount: 1,
        requiredParameterCount: 1,
        parameterTypes: ['string'],
        returnType: 'User',
      },
    );
    const structSave = goDef(
      'struct:SqlRepository.Save',
      'Method',
      'SqlRepository.Save',
      struct.nodeId,
      {
        parameterCount: 1,
        requiredParameterCount: 1,
        parameterTypes: ['User'],
        returnType: 'error',
      },
    );

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceFind, ifaceSave, structFind, structSave]),
      emptyIndexes,
      {} as any,
    );

    expect(implIds(result, iface.nodeId)).toEqual([struct.nodeId]);
  });

  // POLARITY DELIBERATELY REVERSED in #2813 (was: expected `undefined`).
  // A type whose methods use pointer receivers is exactly what idiomatic Go
  // stores in an interface-typed field; excluding it emitted no IMPLEMENTS edge
  // at all, so calls through such a field never reached the implementation.
  // See the rationale block in interface-impls.ts.
  // Exactness, not just presence: a pointer-receiver-only type implements the
  // interface ONLY in pointer form. `var x Closer = PointerOnlyCloser{}` is a
  // compile error in Go and the graph must be able to say so.
  it('treats pointer-receiver-only methods as implementations in POINTER form only', () => {
    const iface = goDef('iface:Closer', 'Interface', 'Closer');
    const struct = goDef('struct:PointerOnlyCloser', 'Struct', 'PointerOnlyCloser');
    const ifaceClose = goDef('iface:Closer.Close', 'Method', 'Closer.Close', iface.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const structClose = goDef(
      'struct:PointerOnlyCloser.Close',
      'Method',
      'PointerOnlyCloser.Close',
      struct.nodeId,
      {
        parameterCount: 0,
        requiredParameterCount: 0,
      },
    );
    (structClose as SymbolDefinition & { goReceiverKind: 'pointer' }).goReceiverKind = 'pointer';

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceClose, structClose]),
      emptyIndexes,
      {} as any,
    );

    expect(implIds(result, iface.nodeId)).toEqual([struct.nodeId]);
    expect(result.get(iface.nodeId)?.[0]?.receiverForm).toBe('pointer');
  });

  it('rejects same-name methods with incompatible parameter types', () => {
    const iface = goDef('iface:Repository', 'Interface', 'Repository');
    const struct = goDef('struct:BadRepository', 'Struct', 'BadRepository');
    const ifaceSave = goDef('iface:Repository.Save', 'Method', 'Repository.Save', iface.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['User'],
      returnType: 'error',
    });
    const badSave = goDef(
      'struct:BadRepository.Save',
      'Method',
      'BadRepository.Save',
      struct.nodeId,
      {
        parameterCount: 1,
        requiredParameterCount: 1,
        parameterTypes: ['string'],
        returnType: 'error',
      },
    );

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceSave, badSave]),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });

  it('preserves Go parameter type shape when checking signatures', () => {
    const iface = goDef('iface:Repository', 'Interface', 'Repository');
    const struct = goDef('struct:BadRepository', 'Struct', 'BadRepository');
    const ifaceSave = goDef('iface:Repository.Save', 'Method', 'Repository.Save', iface.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['[]User'],
      returnType: 'error',
    });
    const badSave = goDef(
      'struct:BadRepository.Save',
      'Method',
      'BadRepository.Save',
      struct.nodeId,
      {
        parameterCount: 1,
        requiredParameterCount: 1,
        parameterTypes: ['User'],
        returnType: 'error',
      },
    );

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceSave, badSave]),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });

  it('does not conflate variadic and slice parameter types in interface signatures', () => {
    const iface = goDef('iface:Repository', 'Interface', 'Repository');
    const struct = goDef('struct:BadRepository', 'Struct', 'BadRepository');
    const ifaceSave = goDef('iface:Repository.Save', 'Method', 'Repository.Save', iface.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 0,
      parameterTypes: ['...User'],
      returnType: 'error',
    });
    const badSave = goDef(
      'struct:BadRepository.Save',
      'Method',
      'BadRepository.Save',
      struct.nodeId,
      {
        parameterCount: 1,
        requiredParameterCount: 1,
        parameterTypes: ['[]User'],
        returnType: 'error',
      },
    );

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceSave, badSave]),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });

  it('preserves variadic element package identity when checking signatures', () => {
    const iface = goDef('iface:Repository', 'Interface', 'Repository', undefined, {
      filePath: 'api/repository.go',
    });
    const struct = goDef('struct:BadRepository', 'Struct', 'BadRepository', undefined, {
      filePath: 'store/repository.go',
    });
    const ifaceSave = goDef('iface:Repository.Save', 'Method', 'Repository.Save', iface.nodeId, {
      filePath: 'api/repository.go',
      parameterCount: 1,
      requiredParameterCount: 0,
      parameterTypes: ['...User'],
      returnType: 'error',
    });
    const badSave = goDef(
      'struct:BadRepository.Save',
      'Method',
      'BadRepository.Save',
      struct.nodeId,
      {
        filePath: 'store/repository.go',
        parameterCount: 1,
        requiredParameterCount: 0,
        parameterTypes: ['...User'],
        returnType: 'error',
      },
    );
    const defs = [iface, struct, ifaceSave, badSave];

    const result = detectGoInterfaceImplementations(
      [
        parsedGoFile('api/repository.go', [iface, ifaceSave]),
        parsedGoFile('store/repository.go', [struct, badSave]),
      ],
      scopeIndexes(defs),
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });

  it('requires methods inherited from embedded interfaces', () => {
    const reader = goDef('iface:Reader', 'Interface', 'Reader');
    const readCloser = goDef('iface:ReadCloser', 'Interface', 'ReadCloser');
    const struct = goDef('struct:PartialFile', 'Struct', 'PartialFile');
    const readerRead = goDef('iface:Reader.Read', 'Method', 'Reader.Read', reader.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const readCloserClose = goDef(
      'iface:ReadCloser.Close',
      'Method',
      'ReadCloser.Close',
      readCloser.nodeId,
      {
        parameterCount: 0,
        requiredParameterCount: 0,
        returnType: 'error',
      },
    );
    const structClose = goDef(
      'struct:PartialFile.Close',
      'Method',
      'PartialFile.Close',
      struct.nodeId,
      {
        parameterCount: 0,
        requiredParameterCount: 0,
        returnType: 'error',
      },
    );

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([reader, readCloser, struct, readerRead, readCloserClose, structClose], {
        scopes: [
          scope('scope:Reader', 'Class', [reader]),
          scope('scope:ReadCloser', 'Class', [readCloser]),
        ],
        referenceSites: [inheritsSite('Reader', 'scope:ReadCloser')],
      }),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(readCloser.nodeId)).toBeUndefined();
  });

  it('accepts structs implementing methods from embedded interfaces', () => {
    const reader = goDef('iface:Reader', 'Interface', 'Reader');
    const readCloser = goDef('iface:ReadCloser', 'Interface', 'ReadCloser');
    const struct = goDef('struct:File', 'Struct', 'File');
    const readerRead = goDef('iface:Reader.Read', 'Method', 'Reader.Read', reader.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const readCloserClose = goDef(
      'iface:ReadCloser.Close',
      'Method',
      'ReadCloser.Close',
      readCloser.nodeId,
      {
        parameterCount: 0,
        requiredParameterCount: 0,
        returnType: 'error',
      },
    );
    const structRead = goDef('struct:File.Read', 'Method', 'File.Read', struct.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const structClose = goDef('struct:File.Close', 'Method', 'File.Close', struct.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });

    const result = detectGoInterfaceImplementations(
      parsedGoDefs(
        [reader, readCloser, struct, readerRead, readCloserClose, structRead, structClose],
        {
          scopes: [
            scope('scope:Reader', 'Class', [reader]),
            scope('scope:ReadCloser', 'Class', [readCloser]),
          ],
          referenceSites: [inheritsSite('Reader', 'scope:ReadCloser')],
        },
      ),
      emptyIndexes,
      {} as any,
    );

    expect(implIds(result, readCloser.nodeId)).toEqual([struct.nodeId]);
  });

  it('accepts structs implementing interface methods through promoted embedded struct methods', () => {
    const reader = goDef('iface:Reader', 'Interface', 'Reader');
    const base = goDef('struct:Base', 'Struct', 'Base');
    const file = goDef('struct:File', 'Struct', 'File');
    const readerRead = goDef('iface:Reader.Read', 'Method', 'Reader.Read', reader.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const baseRead = goDef('struct:Base.Read', 'Method', 'Base.Read', base.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const defs = [reader, base, file, readerRead, baseRead];
    const scopes = [scope('scope:Base', 'Class', [base]), scope('scope:File', 'Class', [file])];

    const result = detectGoInterfaceImplementations(
      parsedGoDefs(defs, {
        scopes,
        referenceSites: [inheritsSite('Base', 'scope:File')],
      }),
      scopeIndexes(defs, scopes),
      {} as any,
    );

    expect(implIds(result, reader.nodeId)).toEqual([base.nodeId, file.nodeId]);
  });

  it('lets direct struct methods shadow promoted embedded struct methods', () => {
    const reader = goDef('iface:Reader', 'Interface', 'Reader');
    const base = goDef('struct:Base', 'Struct', 'Base');
    const shadowFile = goDef('struct:ShadowFile', 'Struct', 'ShadowFile');
    const readerRead = goDef('iface:Reader.Read', 'Method', 'Reader.Read', reader.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const baseRead = goDef('struct:Base.Read', 'Method', 'Base.Read', base.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const shadowRead = goDef(
      'struct:ShadowFile.Read',
      'Method',
      'ShadowFile.Read',
      shadowFile.nodeId,
      {
        parameterCount: 1,
        requiredParameterCount: 1,
        parameterTypes: ['string'],
        returnType: 'error',
      },
    );
    const defs = [reader, base, shadowFile, readerRead, baseRead, shadowRead];
    const scopes = [
      scope('scope:Base', 'Class', [base]),
      scope('scope:ShadowFile', 'Class', [shadowFile]),
    ];

    const result = detectGoInterfaceImplementations(
      parsedGoDefs(defs, {
        scopes,
        referenceSites: [inheritsSite('Base', 'scope:ShadowFile')],
      }),
      scopeIndexes(defs, scopes),
      {} as any,
    );

    expect(implIds(result, reader.nodeId)).toEqual([base.nodeId]);
  });

  it('does not use ambiguous promoted embedded struct methods for interface matching', () => {
    const reader = goDef('iface:Reader', 'Interface', 'Reader');
    const baseA = goDef('struct:BaseA', 'Struct', 'BaseA');
    const baseB = goDef('struct:BaseB', 'Struct', 'BaseB');
    const file = goDef('struct:File', 'Struct', 'File');
    const readerRead = goDef('iface:Reader.Read', 'Method', 'Reader.Read', reader.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const baseARead = goDef('struct:BaseA.Read', 'Method', 'BaseA.Read', baseA.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const baseBRead = goDef('struct:BaseB.Read', 'Method', 'BaseB.Read', baseB.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const defs = [reader, baseA, baseB, file, readerRead, baseARead, baseBRead];
    const scopes = [
      scope('scope:BaseA', 'Class', [baseA]),
      scope('scope:BaseB', 'Class', [baseB]),
      scope('scope:File', 'Class', [file]),
    ];

    const result = detectGoInterfaceImplementations(
      parsedGoDefs(defs, {
        scopes,
        referenceSites: [inheritsSite('BaseA', 'scope:File'), inheritsSite('BaseB', 'scope:File')],
      }),
      scopeIndexes(defs, scopes),
      {} as any,
    );

    expect(implIds(result, reader.nodeId)).toEqual([baseA.nodeId, baseB.nodeId]);
  });

  it('uses the shallowest promoted embedded struct method when deeper methods share the name', () => {
    const reader = goDef('iface:Reader', 'Interface', 'Reader');
    const shallow = goDef('struct:Shallow', 'Struct', 'Shallow');
    const deepBase = goDef('struct:DeepBase', 'Struct', 'DeepBase');
    const deepWrapper = goDef('struct:DeepWrapper', 'Struct', 'DeepWrapper');
    const file = goDef('struct:File', 'Struct', 'File');
    const readerRead = goDef('iface:Reader.Read', 'Method', 'Reader.Read', reader.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const shallowRead = goDef('struct:Shallow.Read', 'Method', 'Shallow.Read', shallow.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const deepRead = goDef('struct:DeepBase.Read', 'Method', 'DeepBase.Read', deepBase.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const defs = [reader, shallow, deepBase, deepWrapper, file, readerRead, shallowRead, deepRead];
    const scopes = [
      scope('scope:Shallow', 'Class', [shallow]),
      scope('scope:DeepBase', 'Class', [deepBase]),
      scope('scope:DeepWrapper', 'Class', [deepWrapper]),
      scope('scope:File', 'Class', [file]),
    ];

    const result = detectGoInterfaceImplementations(
      parsedGoDefs(defs, {
        scopes,
        referenceSites: [
          inheritsSite('DeepBase', 'scope:DeepWrapper'),
          inheritsSite('Shallow', 'scope:File'),
          inheritsSite('DeepWrapper', 'scope:File'),
        ],
      }),
      scopeIndexes(defs, scopes),
      {} as any,
    );

    expect(implIds(result, reader.nodeId)).toEqual([
      shallow.nodeId,
      deepBase.nodeId,
      deepWrapper.nodeId,
      file.nodeId,
    ]);
  });

  it('resolves ambiguous embedded interfaces through imported scope context', () => {
    const readerA = goDef('iface:a.Reader', 'Interface', 'Reader', undefined, {
      filePath: 'a/reader.go',
    });
    const readerB = goDef('iface:b.Reader', 'Interface', 'Reader', undefined, {
      filePath: 'b/reader.go',
    });
    const readCloser = goDef('iface:ReadCloser', 'Interface', 'ReadCloser', undefined, {
      filePath: 'contracts/read_closer.go',
    });
    const file = goDef('struct:File', 'Struct', 'File');
    const closeOnly = goDef('struct:CloseOnly', 'Struct', 'CloseOnly');
    const readerARead = goDef('iface:a.Reader.Read', 'Method', 'Reader.Read', readerA.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const readerBReadWrong = goDef('iface:b.Reader.Read', 'Method', 'Reader.Read', readerB.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['string'],
      returnType: 'error',
    });
    const readCloserClose = goDef(
      'iface:ReadCloser.Close',
      'Method',
      'ReadCloser.Close',
      readCloser.nodeId,
      {
        parameterCount: 0,
        requiredParameterCount: 0,
        returnType: 'error',
      },
    );
    const fileRead = goDef('struct:File.Read', 'Method', 'File.Read', file.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const fileClose = goDef('struct:File.Close', 'Method', 'File.Close', file.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const closeOnlyClose = goDef(
      'struct:CloseOnly.Close',
      'Method',
      'CloseOnly.Close',
      closeOnly.nodeId,
      {
        parameterCount: 0,
        requiredParameterCount: 0,
        returnType: 'error',
      },
    );
    const defs = [
      readerA,
      readerB,
      readCloser,
      file,
      closeOnly,
      readerARead,
      readerBReadWrong,
      readCloserClose,
      fileRead,
      fileClose,
      closeOnlyClose,
    ];
    const scopes = [
      scope('scope:module', 'Module', []),
      scope('scope:ReaderA', 'Class', [readerA], 'scope:module'),
      scope('scope:ReaderB', 'Class', [readerB], 'scope:module'),
      scope('scope:ReadCloser', 'Class', [readCloser], 'scope:module'),
    ];

    const result = detectGoInterfaceImplementations(
      parsedGoDefs(defs, {
        scopes,
        referenceSites: [inheritsSite('Reader', 'scope:ReadCloser')],
      }),
      scopeIndexes(defs, scopes, {
        imports: new Map([
          [
            'scope:module',
            [
              {
                kind: 'namespace',
                localName: 'a',
                targetExportedName: 'a',
                targetFile: 'a/reader.go',
              },
            ],
          ],
        ]),
      }),
      {} as any,
    );

    expect(implIds(result, readCloser.nodeId)).toEqual([file.nodeId]);
  });

  it('does not emit implementations for cyclic embedded interfaces', () => {
    const ifaceA = goDef('iface:A', 'Interface', 'A');
    const ifaceB = goDef('iface:B', 'Interface', 'B');
    const struct = goDef('struct:CycleImpl', 'Struct', 'CycleImpl');
    const ifaceAMethod = goDef('iface:A.A', 'Method', 'A.A', ifaceA.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const ifaceBMethod = goDef('iface:B.B', 'Method', 'B.B', ifaceB.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const structA = goDef('struct:CycleImpl.A', 'Method', 'CycleImpl.A', struct.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const structB = goDef('struct:CycleImpl.B', 'Method', 'CycleImpl.B', struct.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
    });

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([ifaceA, ifaceB, struct, ifaceAMethod, ifaceBMethod, structA, structB], {
        scopes: [scope('scope:A', 'Class', [ifaceA]), scope('scope:B', 'Class', [ifaceB])],
        referenceSites: [inheritsSite('B', 'scope:A'), inheritsSite('A', 'scope:B')],
      }),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(ifaceA.nodeId)).toBeUndefined();
    expect(result.get(ifaceB.nodeId)).toBeUndefined();
  });

  it('allows one struct to satisfy multiple unrelated interfaces', () => {
    const reader = goDef('iface:Reader', 'Interface', 'Reader');
    const closer = goDef('iface:Closer', 'Interface', 'Closer');
    const file = goDef('struct:File', 'Struct', 'File');
    const readerRead = goDef('iface:Reader.Read', 'Method', 'Reader.Read', reader.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const closerClose = goDef('iface:Closer.Close', 'Method', 'Closer.Close', closer.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const fileRead = goDef('struct:File.Read', 'Method', 'File.Read', file.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const fileClose = goDef('struct:File.Close', 'Method', 'File.Close', file.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([reader, closer, file, readerRead, closerClose, fileRead, fileClose]),
      emptyIndexes,
      {} as any,
    );

    expect(implIds(result, reader.nodeId)).toEqual([file.nodeId]);
    expect(implIds(result, closer.nodeId)).toEqual([file.nodeId]);
  });

  it('does not emit implementations when an embedded interface cannot be resolved', () => {
    const readCloser = goDef('iface:ReadCloser', 'Interface', 'ReadCloser');
    const struct = goDef('struct:CloseOnly', 'Struct', 'CloseOnly');
    const readCloserClose = goDef(
      'iface:ReadCloser.Close',
      'Method',
      'ReadCloser.Close',
      readCloser.nodeId,
      {
        parameterCount: 0,
        requiredParameterCount: 0,
        returnType: 'error',
      },
    );
    const structClose = goDef(
      'struct:CloseOnly.Close',
      'Method',
      'CloseOnly.Close',
      struct.nodeId,
      {
        parameterCount: 0,
        requiredParameterCount: 0,
        returnType: 'error',
      },
    );

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([readCloser, struct, readCloserClose, structClose], {
        scopes: [scope('scope:ReadCloser', 'Class', [readCloser])],
        referenceSites: [inheritsSite('io.Reader', 'scope:ReadCloser')],
      }),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(readCloser.nodeId)).toBeUndefined();
  });

  it('allows embedded empty interfaces to contribute no required methods', () => {
    const marker = goDef('iface:Marker', 'Interface', 'Marker');
    const iface = goDef('iface:MarkedSaver', 'Interface', 'MarkedSaver');
    const struct = goDef('struct:Repo', 'Struct', 'Repo');
    const ifaceSave = goDef('iface:MarkedSaver.Save', 'Method', 'MarkedSaver.Save', iface.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const structSave = goDef('struct:Repo.Save', 'Method', 'Repo.Save', struct.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([marker, iface, struct, ifaceSave, structSave], {
        scopes: [
          scope('scope:Marker', 'Class', [marker]),
          scope('scope:MarkedSaver', 'Class', [iface]),
        ],
        referenceSites: [inheritsSite('Marker', 'scope:MarkedSaver')],
      }),
      emptyIndexes,
      {} as any,
    );

    expect(implIds(result, iface.nodeId)).toEqual([struct.nodeId]);
  });

  it('preserves package qualifiers when checking signatures', () => {
    const iface = goDef('iface:Saver', 'Interface', 'Saver');
    const struct = goDef('struct:Repo', 'Struct', 'Repo');
    const ifaceSave = goDef('iface:Saver.Save', 'Method', 'Saver.Save', iface.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['a.User'],
      returnType: 'error',
    });
    const structSave = goDef('struct:Repo.Save', 'Method', 'Repo.Save', struct.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['b.User'],
      returnType: 'error',
    });

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceSave, structSave]),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });

  it('does not match signatures with unresolved import-qualified types', () => {
    const iface = goDef('iface:Saver', 'Interface', 'Saver');
    const struct = goDef('struct:Repo', 'Struct', 'Repo');
    const ifaceSave = goDef('iface:Saver.Save', 'Method', 'Saver.Save', iface.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['missing.User'],
      returnType: 'error',
    });
    const structSave = goDef('struct:Repo.Save', 'Method', 'Repo.Save', struct.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['missing.User'],
      returnType: 'error',
    });

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceSave, structSave]),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });

  // #2873: an out-of-repo package resolves to no file, so it used to be absent
  // from the qualifier map, and a missing qualifier collapsed the whole signature
  // to `undefined` — which both compatibility checks read as "differs". Since
  // `ctx context.Context` opens nearly every idiomatic Go method, that left
  // structural satisfaction working only for builtin-only signatures.
  it('matches signatures qualified by the same out-of-repo package', () => {
    const iface = goDef('iface:Saver', 'Interface', 'Saver');
    const struct = goDef('struct:Repo', 'Struct', 'Repo');
    const ifaceSave = goDef('iface:Saver.Save', 'Method', 'Saver.Save', iface.nodeId, {
      parameterCount: 2,
      requiredParameterCount: 2,
      parameterTypes: ['context.Context', 'string'],
      returnType: 'error',
    });
    const structSave = goDef('struct:Repo.Save', 'Method', 'Repo.Save', struct.nodeId, {
      parameterCount: 2,
      requiredParameterCount: 2,
      parameterTypes: ['context.Context', 'string'],
      returnType: 'error',
    });

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceSave, structSave], {
        parsedImports: [goNamespaceImport('context', 'context')],
      }),
      emptyIndexes,
      {} as any,
    );

    expect(implIds(result, iface.nodeId)).toEqual([struct.nodeId]);
  });

  it('matches an out-of-repo return type across packages', () => {
    const iface = goDef('iface:Ctxer', 'Interface', 'Ctxer', undefined, {
      filePath: 'api/ctx.go',
    });
    const struct = goDef('struct:Impl', 'Struct', 'Impl', undefined, { filePath: 'store/ctx.go' });
    const ifaceCtx = goDef('iface:Ctxer.Ctx', 'Method', 'Ctxer.Ctx', iface.nodeId, {
      filePath: 'api/ctx.go',
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'context.Context',
    });
    const implCtx = goDef('struct:Impl.Ctx', 'Method', 'Impl.Ctx', struct.nodeId, {
      filePath: 'store/ctx.go',
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'context.Context',
    });
    const defs = [iface, struct, ifaceCtx, implCtx];

    const result = detectGoInterfaceImplementations(
      [
        parsedGoFile('api/ctx.go', [iface, ifaceCtx], {
          parsedImports: [goNamespaceImport('context', 'context')],
        }),
        parsedGoFile('store/ctx.go', [struct, implCtx], {
          parsedImports: [goNamespaceImport('context', 'context')],
        }),
      ],
      scopeIndexes(defs),
      {} as any,
    );

    expect(implIds(result, iface.nodeId)).toEqual([struct.nodeId]);
  });

  // The import PATH is the identity, not the local name: an alias changes only
  // how one file spells the package.
  it('matches an aliased out-of-repo import against its unaliased spelling', () => {
    const iface = goDef('iface:Saver', 'Interface', 'Saver', undefined, { filePath: 'api/s.go' });
    const struct = goDef('struct:Repo', 'Struct', 'Repo', undefined, { filePath: 'store/s.go' });
    const ifaceSave = goDef('iface:Saver.Save', 'Method', 'Saver.Save', iface.nodeId, {
      filePath: 'api/s.go',
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['c.Context'],
      returnType: 'error',
    });
    const structSave = goDef('struct:Repo.Save', 'Method', 'Repo.Save', struct.nodeId, {
      filePath: 'store/s.go',
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['context.Context'],
      returnType: 'error',
    });
    const defs = [iface, struct, ifaceSave, structSave];

    const result = detectGoInterfaceImplementations(
      [
        parsedGoFile('api/s.go', [iface, ifaceSave], {
          parsedImports: [goNamespaceImport('c', 'context')],
        }),
        parsedGoFile('store/s.go', [struct, structSave], {
          parsedImports: [goNamespaceImport('context', 'context')],
        }),
      ],
      scopeIndexes(defs),
      {} as any,
    );

    expect(implIds(result, iface.nodeId)).toEqual([struct.nodeId]);
  });

  // The other half of keying on the path: two DIFFERENT out-of-repo packages
  // whose last segment collides still have to compare unequal.
  it('rejects same-named out-of-repo packages with different import paths', () => {
    const iface = goDef('iface:Dialer', 'Interface', 'Dialer', undefined, { filePath: 'api/d.go' });
    const struct = goDef('struct:Impl', 'Struct', 'Impl', undefined, { filePath: 'store/d.go' });
    const ifaceDial = goDef('iface:Dialer.Dial', 'Method', 'Dialer.Dial', iface.nodeId, {
      filePath: 'api/d.go',
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['client.Config'],
      returnType: 'error',
    });
    const implDial = goDef('struct:Impl.Dial', 'Method', 'Impl.Dial', struct.nodeId, {
      filePath: 'store/d.go',
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['client.Config'],
      returnType: 'error',
    });
    const defs = [iface, struct, ifaceDial, implDial];

    const result = detectGoInterfaceImplementations(
      [
        parsedGoFile('api/d.go', [iface, ifaceDial], {
          parsedImports: [goNamespaceImport('client', 'example.com/alpha/client')],
        }),
        parsedGoFile('store/d.go', [struct, implDial], {
          parsedImports: [goNamespaceImport('client', 'example.com/beta/client')],
        }),
      ],
      scopeIndexes(defs),
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });

  // The fallback fills gaps, it does not compete: an import that DID resolve
  // in-repo keeps its package directory, which is the spelling a file inside
  // that package produces for its own bare type names.
  it('prefers the in-repo package directory over the import path', () => {
    const iface = goDef('iface:Saver', 'Interface', 'Saver', undefined, { filePath: 'api/s.go' });
    const struct = goDef('struct:User', 'Struct', 'User', undefined, {
      filePath: 'model/user.go',
    });
    const ifaceSave = goDef('iface:Saver.Save', 'Method', 'Saver.Save', iface.nodeId, {
      filePath: 'api/s.go',
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['model.User'],
      returnType: 'error',
    });
    // Declared inside package `model`, so it spells its own type bare.
    const structSave = goDef('struct:User.Save', 'Method', 'User.Save', struct.nodeId, {
      filePath: 'model/user.go',
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['User'],
      returnType: 'error',
    });
    const defs = [iface, struct, ifaceSave, structSave];
    const apiScope = 'scope:api' as ScopeId;

    const result = detectGoInterfaceImplementations(
      [
        parsedGoFile('api/s.go', [iface, ifaceSave], {
          moduleScope: apiScope,
          // Both channels name `model`; only the resolved edge may win.
          parsedImports: [goNamespaceImport('model', 'example.com/x/model')],
        }),
        parsedGoFile('model/user.go', [struct, structSave]),
      ],
      scopeIndexes(defs, [], {
        imports: new Map([
          [
            apiScope,
            [
              {
                kind: 'namespace',
                localName: 'model',
                targetFile: 'model/user.go',
                targetExportedName: 'model',
              } as ImportEdge,
            ],
          ],
        ]),
      }),
      {} as any,
    );

    expect(implIds(result, iface.nodeId)).toEqual([struct.nodeId]);
  });

  // The extractor derives the local name from the LAST path segment, which for a
  // module at v2+ is the version, not the package. Source still writes `bar.`.
  it('recovers the package name from a major-version import path', () => {
    const iface = goDef('iface:Saver', 'Interface', 'Saver', undefined, { filePath: 'api/s.go' });
    const struct = goDef('struct:Repo', 'Struct', 'Repo', undefined, { filePath: 'store/s.go' });
    const ifaceSave = goDef('iface:Saver.Save', 'Method', 'Saver.Save', iface.nodeId, {
      filePath: 'api/s.go',
      parameterCount: 2,
      requiredParameterCount: 2,
      parameterTypes: ['bar.Config', 'yaml.Node'],
      returnType: 'error',
    });
    const structSave = goDef('struct:Repo.Save', 'Method', 'Repo.Save', struct.nodeId, {
      filePath: 'store/s.go',
      parameterCount: 2,
      requiredParameterCount: 2,
      parameterTypes: ['bar.Config', 'yaml.Node'],
      returnType: 'error',
    });
    const defs = [iface, struct, ifaceSave, structSave];
    const imports = [
      goNamespaceImport('v2', 'github.com/foo/bar/v2'),
      goNamespaceImport('yaml.v3', 'gopkg.in/yaml.v3'),
    ];

    const result = detectGoInterfaceImplementations(
      [
        parsedGoFile('api/s.go', [iface, ifaceSave], { parsedImports: imports }),
        parsedGoFile('store/s.go', [struct, structSave], { parsedImports: imports }),
      ],
      scopeIndexes(defs),
      {} as any,
    );

    expect(implIds(result, iface.nodeId)).toEqual([struct.nodeId]);
  });

  // Two majors of one module are two packages, and Go forces an alias to import
  // both. The alias owns its token; the bare name stays with the unaliased one.
  it('keeps two major versions of the same module distinct', () => {
    const iface = goDef('iface:Saver', 'Interface', 'Saver', undefined, { filePath: 'api/s.go' });
    const struct = goDef('struct:Repo', 'Struct', 'Repo', undefined, { filePath: 'store/s.go' });
    const ifaceSave = goDef('iface:Saver.Save', 'Method', 'Saver.Save', iface.nodeId, {
      filePath: 'api/s.go',
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['bar.Config'],
      returnType: 'error',
    });
    const structSave = goDef('struct:Repo.Save', 'Method', 'Repo.Save', struct.nodeId, {
      filePath: 'store/s.go',
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['bar.Config'],
      returnType: 'error',
    });
    const defs = [iface, struct, ifaceSave, structSave];

    const result = detectGoInterfaceImplementations(
      [
        // `bar` here is v1 …
        parsedGoFile('api/s.go', [iface, ifaceSave], {
          parsedImports: [goNamespaceImport('bar', 'github.com/foo/bar')],
        }),
        // … and here it is the alias of v2, imported alongside v1.
        parsedGoFile('store/s.go', [struct, structSave], {
          parsedImports: [
            goNamespaceImport('v1', 'github.com/foo/bar'),
            {
              kind: 'namespace',
              localName: 'bar',
              importedName: 'v2',
              targetRaw: 'github.com/foo/bar/v2',
            } as ParsedImport,
          ],
        }),
      ],
      scopeIndexes(defs),
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });

  // Go's dot-import has no qualifier to register, and the extractor gives it a
  // different `ParsedImport` kind for that reason. Blank imports never reach
  // here at all.
  it('registers no qualifier for a dot-import', () => {
    const iface = goDef('iface:Saver', 'Interface', 'Saver');
    const struct = goDef('struct:Repo', 'Struct', 'Repo');
    const ifaceSave = goDef('iface:Saver.Save', 'Method', 'Saver.Save', iface.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['dotted.User'],
      returnType: 'error',
    });
    const structSave = goDef('struct:Repo.Save', 'Method', 'Repo.Save', struct.nodeId, {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['dotted.User'],
      returnType: 'error',
    });

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceSave, structSave], {
        parsedImports: [{ kind: 'wildcard', targetRaw: 'example.com/x/dotted' } as ParsedImport],
      }),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });

  it('rejects methods missing an interface-required return type', () => {
    const iface = goDef('iface:Closer', 'Interface', 'Closer');
    const struct = goDef('struct:NoReturnCloser', 'Struct', 'NoReturnCloser');
    const ifaceClose = goDef('iface:Closer.Close', 'Method', 'Closer.Close', iface.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'error',
    });
    const structClose = goDef(
      'struct:NoReturnCloser.Close',
      'Method',
      'NoReturnCloser.Close',
      struct.nodeId,
      {
        parameterCount: 0,
        requiredParameterCount: 0,
      },
    );

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceClose, structClose]),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });

  it('rejects methods with fewer grouped return values than the interface requires', () => {
    const iface = goDef('iface:PairReader', 'Interface', 'PairReader');
    const struct = goDef('struct:SingleReader', 'Struct', 'SingleReader');
    const ifaceRead = goDef('iface:PairReader.Read', 'Method', 'PairReader.Read', iface.nodeId, {
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: '(int, int)',
    });
    const structRead = goDef(
      'struct:SingleReader.Read',
      'Method',
      'SingleReader.Read',
      struct.nodeId,
      {
        parameterCount: 0,
        requiredParameterCount: 0,
        returnType: 'int',
      },
    );

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceRead, structRead]),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });

  it('rejects interface methods without enough signature metadata', () => {
    const iface = goDef('iface:Repository', 'Interface', 'Repository');
    const struct = goDef('struct:SqlRepository', 'Struct', 'SqlRepository');
    const ifaceSave = goDef('iface:Repository.Save', 'Method', 'Repository.Save', iface.nodeId);
    const structSave = goDef(
      'struct:SqlRepository.Save',
      'Method',
      'SqlRepository.Save',
      struct.nodeId,
      {
        parameterCount: 1,
        requiredParameterCount: 1,
        parameterTypes: ['User'],
        returnType: 'error',
      },
    );

    const result = detectGoInterfaceImplementations(
      parsedGoDefs([iface, struct, ifaceSave, structSave]),
      emptyIndexes,
      {} as any,
    );

    expect(result.get(iface.nodeId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #2829 review: `goReceiverKind` must stay stamped even though nothing filters
// on it any more.
// ---------------------------------------------------------------------------
//
// #2813 removed the only functional READER of `goReceiverKind` (the
// pointer-receiver exclusion in `buildDetectionIndexes`). The field is kept
// deliberately — it is the hook a future value/pointer-aware model would read,
// and `interpret.ts` preserves the raw `*T` shape specifically to feed it. But
// a written-and-never-read field rots: before these rows you could delete the
// assignment in `method-owners.ts` and the whole suite stayed green.
//
// These pin the stamp itself, so the promise the comment makes stays true.
describe('Go method-owner receiver-kind stamping (#2829)', () => {
  const ownerScope = (receiverRaw: string, methodDef: SymbolDefinition): Scope => {
    const s = scope('fn:1' as ScopeId, 'Function', [methodDef]);
    (s.typeBindings as Map<string, unknown>).set('r', {
      rawName: receiverRaw,
      source: 'self',
    });
    return s;
  };

  const stampFor = (receiverRaw: string): SymbolDefinition => {
    const struct = goDef('struct:Repo', 'Struct', 'Repo');
    const method = goDef('struct:Repo.Save', 'Method', 'Save');
    const parsed = {
      filePath: 'repo.go',
      language: 'go',
      scopes: [scope('mod' as ScopeId, 'Module', [struct]), ownerScope(receiverRaw, method)],
      imports: [],
      localDefs: [struct, method],
      referenceSites: [],
    } as any;
    populateGoOwners(parsed);
    return method;
  };

  it('stamps a POINTER receiver as pointer', () => {
    const m = stampFor('*Repo') as SymbolDefinition & { goReceiverKind?: string };
    expect(m.goReceiverKind).toBe('pointer');
    expect(m.ownerId).toBe('struct:Repo');
  });

  it('stamps a VALUE receiver as value', () => {
    const m = stampFor('Repo') as SymbolDefinition & { goReceiverKind?: string };
    expect(m.goReceiverKind).toBe('value');
    expect(m.ownerId).toBe('struct:Repo');
  });
});
