import { describe, expect, it } from 'vitest';
import type {
  BindingRef,
  Callsite,
  ReferenceSite,
  Scope,
  ScopeId,
  SymbolDefinition,
} from 'gitnexus-shared';
import {
  goArityCompatibility,
  goMergeBindings,
  goReceiverBinding,
} from '../../../../src/core/ingestion/languages/go/index.js';
import { detectGoInterfaceImplementations } from '../../../../src/core/ingestion/languages/go/interface-impls.js';

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
  } = {},
) {
  return [
    {
      filePath: 'repo.go',
      language: 'go',
      scopes: options.scopes ?? [],
      imports: [],
      localDefs: [...defs],
      referenceSites: options.referenceSites ?? [],
    },
  ] as any;
}

const emptyIndexes = {} as any;

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

    expect(result.get(iface.nodeId)).toEqual([struct.nodeId]);
  });

  it('does not treat pointer-receiver-only methods as value type implementations', () => {
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

    expect(result.get(iface.nodeId)).toBeUndefined();
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

    expect(result.get(readCloser.nodeId)).toEqual([struct.nodeId]);
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

    expect(result.get(iface.nodeId)).toEqual([struct.nodeId]);
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
