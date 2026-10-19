import { describe, expect, it } from 'vitest';
import {
  buildFetchWrapperIndex,
  resolveFetchWrapperTargets,
} from '../../src/core/ingestion/route-extractors/fetch-wrapper-index.js';
import type {
  CalleeTarget,
  FetchWrapperCall,
  FetchWrapperReexport,
} from '../../src/core/ingestion/route-extractors/fetch-wrapper.js';
import type { FetchWrapperDef } from '../../src/core/ingestion/workers/parse-worker.js';

function definition(id: string, overrides: Partial<FetchWrapperDef> = {}): FetchWrapperDef {
  return {
    filePath: 'client.ts',
    functionName: 'request',
    definitionId: id,
    bindingId: id,
    moduleScope: true,
    exportedNames: ['request'],
    seed: false,
    forwardsUrl: false,
    forwardsTo: [],
    ...overrides,
  };
}

function call(target: CalleeTarget, functionName = 'request'): FetchWrapperCall {
  return { filePath: 'client.ts', functionName, target, fetchURL: '/api/items', lineNumber: 1 };
}

describe('fetch wrapper target classification', () => {
  it('uses the local binding rather than a same-named wrapper elsewhere', () => {
    const index = buildFetchWrapperIndex([
      definition('wrapper', { seed: true }),
      definition('plain', { moduleScope: false, exportedNames: [] }),
    ]);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'wrapper' }))).toBe(true);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'plain' }))).toBe(false);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'parameter' }))).toBe(false);
    expect(index.isWrapperCall(call({ kind: 'blocked' }))).toBe(false);
  });

  it('includes file identity when classifying bindings', () => {
    const index = buildFetchWrapperIndex([
      definition('same', { filePath: 'other.ts', seed: true }),
    ]);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'same' }))).toBe(false);
  });

  it('requires one declaration for a binding, independently of duplicate captures', () => {
    const wrapper = definition('one', { seed: true });
    expect(
      buildFetchWrapperIndex([wrapper, { ...wrapper }]).isWrapperCall(
        call({ kind: 'binding', bindingId: 'one' }),
      ),
    ).toBe(true);
    expect(
      buildFetchWrapperIndex([
        wrapper,
        definition('two', { bindingId: 'one', seed: true }),
      ]).isWrapperCall(call({ kind: 'binding', bindingId: 'one' })),
    ).toBe(false);
  });

  it('resolves renamed imports to the exported name in the actual module', () => {
    const index = buildFetchWrapperIndex([
      definition('wrapper', {
        filePath: 'http.ts',
        functionName: 'send',
        exportedNames: ['request', 'default'],
        seed: true,
      }),
      definition('nested', {
        filePath: 'http.ts',
        moduleScope: false,
        exportedNames: [],
        seed: true,
      }),
      definition('plain', { filePath: 'ipc.ts' }),
    ]);
    expect(
      index.isWrapperCall(
        call({ kind: 'resolved-import', filePath: 'http.ts', importedName: 'request' }, 'renamed'),
      ),
    ).toBe(true);
    expect(
      index.isWrapperCall(
        call(
          { kind: 'resolved-import', filePath: 'http.ts', importedName: 'default' },
          'defaultClient',
        ),
      ),
    ).toBe(true);
    expect(
      index.isWrapperCall(
        call({ kind: 'resolved-import', filePath: 'http.ts', importedName: 'send' }),
      ),
    ).toBe(false);
    expect(
      index.isWrapperCall(
        call({ kind: 'resolved-import', filePath: 'ipc.ts', importedName: 'request' }),
      ),
    ).toBe(false);
    expect(
      index.isWrapperCall(
        call({ kind: 'resolved-import', filePath: 'missing.ts', importedName: 'request' }),
      ),
    ).toBe(false);
  });

  it('does not mistake a nested homonym for a module export', () => {
    const index = buildFetchWrapperIndex([
      definition('nested', { moduleScope: false, exportedNames: ['request'], seed: true }),
    ]);
    expect(
      index.isWrapperCall(
        call({ kind: 'resolved-import', filePath: 'client.ts', importedName: 'request' }),
      ),
    ).toBe(false);
  });

  it.each([false, true])(
    'declines unresolved names with two definitions, second seed=%s',
    (seed) => {
      const index = buildFetchWrapperIndex([
        definition('one', { seed: true }),
        definition('two', { filePath: 'other.ts', seed }),
      ]);
      expect(index.isWrapperCall(call({ kind: 'unresolved' }))).toBe(false);
      expect(
        index.isWrapperCall(
          call({ kind: 'import', specifier: 'missing', importedName: 'request' }, 'renamed'),
        ),
      ).toBe(false);
    },
  );

  it('permits unique unresolved fallback while duplicate captures remain one definition', () => {
    const wrapper = definition('one', { seed: true });
    const index = buildFetchWrapperIndex([wrapper, { ...wrapper }]);
    expect(index.isWrapperCall(call({ kind: 'unresolved' }))).toBe(true);
    expect(
      index.isWrapperCall(
        call({ kind: 'import', specifier: 'missing', importedName: 'request' }, 'renamed'),
      ),
    ).toBe(true);
    expect(index.isWrapperCall(call({ kind: 'unresolved' }, 'missing'))).toBe(false);
  });

  it('matches configured names before checking local or blocked bindings', () => {
    const index = buildFetchWrapperIndex([], ['request']);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'parameter' }))).toBe(true);
    expect(index.isWrapperCall(call({ kind: 'blocked' }))).toBe(true);
    expect(
      buildFetchWrapperIndex([]).isWrapperCall(call({ kind: 'binding', bindingId: 'parameter' })),
    ).toBe(false);
  });

  it('preserves member-call name matching across duplicate names', () => {
    const index = buildFetchWrapperIndex([
      definition('one', { functionName: 'api.request', seed: true }),
      definition('two', { functionName: 'api.request' }),
    ]);
    expect(index.isWrapperCall(call({ kind: 'member' }, 'api.request'))).toBe(true);
    expect(index.isWrapperCall(call({ kind: 'member' }, 'api.other'))).toBe(false);
  });
});

describe('fetch wrapper forwarding propagation', () => {
  it('distinguishes a seed from a URL carrier', () => {
    const index = buildFetchWrapperIndex([
      definition('track', { functionName: 'track', seed: true }),
      definition('outer', {
        forwardsTo: [{ callee: 'track', target: { kind: 'binding', bindingId: 'track' } }],
      }),
    ]);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'track' }, 'track'))).toBe(true);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'outer' }))).toBe(false);
  });

  it.each([false, true])(
    'uses the same unique fallback for forwarding, duplicate=%s',
    (duplicate) => {
      const defs = [
        definition('carrier', { functionName: 'send', forwardsUrl: true }),
        definition('outer', { forwardsTo: [{ callee: 'send', target: { kind: 'unresolved' } }] }),
      ];
      if (duplicate) defs.push(definition('other', { functionName: 'send' }));
      const index = buildFetchWrapperIndex(defs);
      expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'outer' }))).toBe(!duplicate);
    },
  );

  it('propagates imported identity and configured overrides through forwarding', () => {
    const index = buildFetchWrapperIndex(
      [
        definition('carrier', {
          filePath: 'http.ts',
          functionName: 'send',
          exportedNames: ['request'],
          forwardsUrl: true,
        }),
        definition('imported', {
          forwardsTo: [
            {
              callee: 'renamed',
              target: { kind: 'resolved-import', filePath: 'http.ts', importedName: 'request' },
            },
          ],
        }),
        definition('configured', {
          forwardsTo: [{ callee: 'custom', target: { kind: 'binding', bindingId: 'parameter' } }],
        }),
        definition('blocked', { forwardsTo: [{ callee: 'request', target: { kind: 'blocked' } }] }),
      ],
      ['custom'],
    );
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'imported' }))).toBe(true);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'configured' }))).toBe(true);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'blocked' }))).toBe(false);
  });

  it('propagates a reversed long chain without recursion and excludes unrooted cycles', () => {
    const count = 5000;
    const defs = Array.from({ length: count }, (_, i) =>
      definition(String(i), {
        functionName: `request${i}`,
        forwardsUrl: i === count - 1,
        forwardsTo:
          i === count - 1
            ? []
            : [
                {
                  callee: `request${i + 1}`,
                  target: { kind: 'binding', bindingId: String(i + 1) },
                },
              ],
      }),
    );
    defs.push(
      definition('cycleA', {
        forwardsTo: [{ callee: 'request', target: { kind: 'binding', bindingId: 'cycleB' } }],
      }),
      definition('cycleB', {
        forwardsTo: [{ callee: 'request', target: { kind: 'binding', bindingId: 'cycleA' } }],
      }),
    );
    const index = buildFetchWrapperIndex(defs);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: '0' }, 'request0'))).toBe(true);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'cycleA' }))).toBe(false);
    expect(index.isWrapperCall(call({ kind: 'binding', bindingId: 'cycleB' }))).toBe(false);
  });

  it('preserves the all-carriers requirement for member forwarding', () => {
    const wrapper = definition('outer', {
      forwardsTo: [{ callee: 'api.send', target: { kind: 'member' } }],
    });
    const defs = [
      wrapper,
      definition('one', { functionName: 'api.send', forwardsUrl: true }),
      definition('two', { functionName: 'api.send', forwardsUrl: true }),
    ];
    expect(
      buildFetchWrapperIndex(defs).isWrapperCall(call({ kind: 'binding', bindingId: 'outer' })),
    ).toBe(true);
    defs[2] = { ...defs[2], forwardsUrl: false, seed: true };
    expect(
      buildFetchWrapperIndex(defs).isWrapperCall(call({ kind: 'binding', bindingId: 'outer' })),
    ).toBe(false);
  });
});

describe('fetch wrapper import target resolution', () => {
  it('resolves each file/specifier once across calls and forwarding facts', () => {
    const target = { kind: 'import', specifier: '@http', importedName: 'request' } as const;
    const defs = [definition('outer', { forwardsTo: [{ callee: 'send', target }] })];
    const calls = [call(target, 'send'), call(target, 'send')];
    const resolved: string[] = [];
    const result = resolveFetchWrapperTargets(defs, calls, (fromFile, specifier) => {
      resolved.push(`${fromFile}:${specifier}`);
      return ['http.ts'];
    });
    expect(resolved).toEqual(['client.ts:@http']);
    const expected = { kind: 'resolved-import', filePath: 'http.ts', importedName: 'request' };
    expect(result.calls.map((candidate) => candidate.target)).toEqual([expected, expected]);
    expect(result.definitions[0].forwardsTo[0].target).toEqual(expected);
    expect(calls.map((candidate) => candidate.target)).toEqual([target, target]);
    expect(defs[0].forwardsTo[0].target).toEqual(target);
  });

  it('preserves unavailable targets for unique fallback and blocks ambiguous modules', () => {
    const calls = [
      call({ kind: 'import', specifier: 'missing', importedName: 'request' }),
      call({ kind: 'import', specifier: 'ambiguous', importedName: 'request' }),
      call({ kind: 'binding', bindingId: 'local' }),
    ];
    const result = resolveFetchWrapperTargets([], calls, (_fromFile, specifier) =>
      specifier === 'missing' ? [] : ['a.ts', 'b.ts'],
    );
    expect(result.calls.map((candidate) => candidate.target)).toEqual([
      { kind: 'import', specifier: 'missing', importedName: 'request' },
      { kind: 'blocked' },
      { kind: 'binding', bindingId: 'local' },
    ]);
  });
});

describe('fetch wrapper barrel resolution', () => {
  const declares = (filePath: string, name: string) =>
    definition(`${filePath}:${name}`, {
      filePath,
      functionName: name,
      exportedNames: [name],
      seed: true,
    });
  const forward = (
    filePath: string,
    exportedName: string,
    specifier?: string,
    importedName = exportedName,
  ): FetchWrapperReexport => ({
    filePath,
    exportedName,
    ...(specifier ? { from: { specifier, importedName } } : {}),
  });
  const resolveIn = (
    reexports: FetchWrapperReexport[],
    name = 'request',
    defs = [declares('request.ts', 'request'), declares('other.ts', 'request')],
  ) =>
    resolveFetchWrapperTargets(
      defs,
      [call({ kind: 'import', specifier: '@pkg', importedName: name }, name)],
      (fromFile, specifier) =>
        specifier === '@pkg' ? ['index.ts'] : [specifier.replace(/^\.\//, '') + '.ts'],
      reexports,
    ).calls[0].target;
  const at = (filePath: string, importedName = 'request') => ({
    kind: 'resolved-import',
    filePath,
    importedName,
  });

  it.each([
    ['a named re-export', [forward('index.ts', 'request', './request')], at('request.ts')],
    [
      'a renamed re-export',
      [forward('index.ts', 'request', './request', 'request')],
      at('request.ts'),
    ],
    ['a star re-export', [forward('index.ts', '*', './request', '*')], at('request.ts')],
    [
      'a chain of barrels',
      [forward('index.ts', '*', './mid', '*'), forward('mid.ts', 'request', './request')],
      at('request.ts'),
    ],
    [
      'a named re-export shadowing a star export',
      [forward('index.ts', 'request', './request'), forward('index.ts', '*', './other', '*')],
      at('request.ts'),
    ],
    [
      'two star exports reaching one declaration',
      [
        forward('index.ts', '*', './left', '*'),
        forward('index.ts', '*', './right', '*'),
        forward('left.ts', '*', './request', '*'),
        forward('right.ts', '*', './request', '*'),
      ],
      at('request.ts'),
    ],
    [
      'conflicting star exports',
      [forward('index.ts', '*', './request', '*'), forward('index.ts', '*', './other', '*')],
      { kind: 'blocked' },
    ],
    [
      'a local export shadowing a star export',
      [forward('index.ts', 'request'), forward('index.ts', '*', './request', '*')],
      at('index.ts'),
    ],
    [
      'a re-export cycle',
      [forward('index.ts', '*', './loop', '*'), forward('loop.ts', '*', './index', '*')],
      at('index.ts'),
    ],
  ])('resolves %s', (_shape, reexports, expected) => {
    expect(resolveIn(reexports)).toEqual(expected);
  });

  it('never forwards default through a star export', () => {
    expect(
      resolveIn([forward('index.ts', '*', './request', '*')], 'default', [
        declares('request.ts', 'default'),
      ]),
    ).toEqual(at('index.ts', 'default'));
  });

  it('classifies a call through a barrel as the declaring wrapper', () => {
    const defs = [declares('request.ts', 'request')];
    const resolved = resolveFetchWrapperTargets(
      defs,
      [call({ kind: 'import', specifier: '@pkg', importedName: 'request' })],
      (_fromFile, specifier) => (specifier === '@pkg' ? ['index.ts'] : ['request.ts']),
      [forward('index.ts', 'request', './request')],
    );
    expect(buildFetchWrapperIndex(resolved.definitions).isWrapperCall(resolved.calls[0])).toBe(
      true,
    );
  });
});
