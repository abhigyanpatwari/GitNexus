import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type Range,
  type Scope,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createSemanticModel } from '../../../../src/core/ingestion/model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';
import {
  captureJavaOverloadFacts,
  clearJavaOverloadFacts,
  setJavaOverloadFacts,
} from '../../../../src/core/ingestion/languages/java/overload-argument-facts.js';
import { resolveJavaReceiverMember } from '../../../../src/core/ingestion/languages/java/overload-resolution.js';
import { getJavaParser } from '../../../../src/core/ingestion/languages/java/query.js';

function resolveSynthetic(
  signatures: readonly { count: number; types?: readonly string[] }[],
  arity = 1,
) {
  const filePath = 'Synthetic.java';
  const range: Range = { startLine: 1, startCol: 0, endLine: 10, endCol: 0 };
  const atRange: Range = { startLine: 5, startCol: 0, endLine: 5, endCol: 12 };
  const owner: SymbolDefinition = {
    nodeId: 'Class:Synthetic.java:Pair',
    filePath,
    type: 'Class',
    qualifiedName: 'Pair',
    declarationRange: range,
  };
  const methods: SymbolDefinition[] = signatures.map((signature, index) => ({
    nodeId: `Method:Synthetic.java:Pair.setValue#${index}`,
    filePath,
    type: 'Method',
    ownerId: owner.nodeId,
    qualifiedName: 'Pair.setValue',
    parameterCount: signature.count,
    parameterTypes: signature.types === undefined ? undefined : [...signature.types],
    isSynthetic: true,
  }));
  const classScope: Scope = {
    id: 'class',
    kind: 'Class',
    parent: 'module',
    filePath,
    range,
    ownedDefs: [owner, ...methods],
    imports: [],
    bindings: new Map(),
    typeBindings: new Map(),
  };
  const moduleScope: Scope = {
    ...classScope,
    id: 'module',
    kind: 'Module',
    parent: null,
    ownedDefs: [],
  };
  const definitions = [owner, ...methods];
  const scopes = {
    scopeTree: buildScopeTree([moduleScope, classScope]),
    defs: buildDefIndex(definitions),
    qualifiedNames: buildQualifiedNameIndex(definitions),
    methodDispatch: buildMethodDispatchIndex({
      owners: [owner.nodeId],
      computeMro: () => [],
      implementsOf: () => [],
    }),
  } as ScopeResolutionIndexes;
  const model = createSemanticModel();
  for (const method of methods) model.methods.register(owner.nodeId, 'setValue', method);
  setJavaOverloadFacts(filePath, {
    version: 1,
    packageName: '',
    imports: [],
    types: [
      {
        name: 'Pair',
        simpleName: 'Pair',
        kind: 'class_declaration',
        range,
        visible: range,
        bases: [],
        typeParameters: [],
      },
    ],
    methods: [],
    calls: [
      {
        name: 'setValue',
        range: atRange,
        arguments: Array.from({ length: arity }, () => ({
          kind: 'typed',
          spelling: 'int',
          at: atRange,
        })),
        receiverIsValue: true,
        staticContext: false,
      },
    ],
  });
  return resolveJavaReceiverMember(
    owner,
    'setValue',
    { inScope: classScope.id, kind: 'call', callForm: 'member', name: 'setValue', atRange, arity },
    scopes,
    model,
  );
}

function hierarchyFixture(
  declarations: readonly string[],
  bases: readonly string[],
  conversion?: {
    argumentType: string;
    parameterTypes: readonly [string, string];
  },
) {
  const filePath = 'Hierarchy.java';
  const parameterTypes = conversion?.parameterTypes ?? ['Long', 'String'];
  const source = `${declarations.join('\n')}
    class Owner ${bases.length === 0 ? '' : `implements ${bases.join(', ')}`} {
      public void pick(${parameterTypes[0]} value) {}
      public void pick(${parameterTypes[1]} value) {}
      void run(${conversion === undefined ? '' : `${conversion.argumentType} value`}) {
        pick(${conversion === undefined ? '1L' : 'value'});
      }
    }`;
  const facts = captureJavaOverloadFacts(getJavaParser().parse(source).rootNode)!;
  let baseReads = 0;
  for (const type of facts.types) {
    const declaredBases = type.bases;
    Object.defineProperty(type, 'bases', {
      get() {
        baseReads++;
        return declaredBases;
      },
    });
  }
  const owners: SymbolDefinition[] = facts.types.map((type) => ({
    nodeId: `${type.kind === 'interface_declaration' ? 'Interface' : 'Class'}:${filePath}:${type.name}`,
    filePath,
    type: type.kind === 'interface_declaration' ? 'Interface' : 'Class',
    qualifiedName: type.name,
    declarationRange: type.range,
  }));
  const owner = owners.find((definition) => definition.qualifiedName === 'Owner')!;
  const methods: SymbolDefinition[] = facts.methods
    .filter((method) => method.name === 'pick')
    .map((method, index) => ({
      nodeId: `Method:${filePath}:Owner.pick#${index}`,
      filePath,
      type: 'Method',
      ownerId: owner.nodeId,
      qualifiedName: 'Owner.pick',
      declarationRange: method.range,
      parameterCount: method.parameterTypes.length,
      parameterTypes: [...method.parameterTypes],
    }));
  const classScope: Scope = {
    id: 'class',
    kind: 'Class',
    parent: 'module',
    filePath,
    range: owner.declarationRange!,
    ownedDefs: [owner, ...methods],
    imports: [],
    bindings: new Map(),
    typeBindings: new Map(),
  };
  const moduleScope: Scope = { ...classScope, id: 'module', kind: 'Module', parent: null };
  const definitions = [...owners, ...methods];
  const scopes = {
    scopeTree: buildScopeTree([moduleScope, classScope]),
    defs: buildDefIndex(definitions),
    qualifiedNames: buildQualifiedNameIndex(definitions),
    // Only Owner declares methods. The captured bases supply the independent
    // hierarchy-completeness proof; no inherited-member lookup is needed.
    methodDispatch: buildMethodDispatchIndex({
      owners: owners.map((definition) => definition.nodeId),
      computeMro: () => [],
      implementsOf: () => [],
    }),
  } as ScopeResolutionIndexes;
  const model = createSemanticModel();
  for (const method of methods) model.methods.register(owner.nodeId, 'pick', method);
  setJavaOverloadFacts(filePath, facts);
  const call = facts.calls.find((site) => site.name === 'pick')!;
  return {
    baseReads: () => baseReads,
    resolve: () =>
      resolveJavaReceiverMember(
        owner,
        'pick',
        {
          inScope: classScope.id,
          kind: 'call',
          callForm: 'member',
          name: 'pick',
          atRange: call.range,
          arity: 1,
        },
        scopes,
        model,
      ),
  };
}

afterEach(clearJavaOverloadFacts);

describe('Java overload fact lookup work', () => {
  it.each(['none', 'method', 'nested'])(
    'bounds declaration reads across independent families (generics=%s)',
    (generics) => {
      const size = 64;
      const generic = generics !== 'none';
      const filePath = 'Wide.java';
      const source = `class Wide${generics === 'nested' ? '<String>' : ''} { ${Array.from(
        { length: size },
        (_, i) => `
      void pick${i}(Object value) {}
      void pick${i}(String value) {}
      ${generic ? '<String>' : ''} void run${i}(${generic ? 'String value' : ''}) { pick${i}(${generic ? 'value' : '"text"'}); }
    `,
      ).join('\n')} }`;
      const facts = captureJavaOverloadFacts(getJavaParser().parse(source).rootNode)!;
      const owner: SymbolDefinition = {
        nodeId: `Class:${filePath}:Wide`,
        filePath,
        type: 'Class',
        qualifiedName: 'Wide',
        declarationRange: facts.types[0]!.range,
      };
      const methods: SymbolDefinition[] = facts.methods
        .filter((fact) => fact.name.startsWith('pick'))
        .map((fact) => ({
          nodeId: `Method:${filePath}:Wide.${fact.name}#1~${fact.parameterTypes[0]}`,
          filePath,
          type: 'Method',
          ownerId: owner.nodeId,
          qualifiedName: `Wide.${fact.name}`,
          declarationRange: fact.range,
          parameterCount: 1,
          parameterTypes: [...fact.parameterTypes],
        }));
      const classScope: Scope = {
        id: 'class',
        kind: 'Class',
        parent: 'module',
        filePath,
        range: owner.declarationRange!,
        ownedDefs: [owner, ...methods],
        imports: [],
        bindings: new Map(),
        typeBindings: new Map(),
      };
      const definitions = [owner, ...methods];
      const scopes = {
        scopeTree: buildScopeTree([
          { ...classScope, id: 'module', kind: 'Module', parent: null },
          classScope,
        ]),
        defs: buildDefIndex(definitions),
        qualifiedNames: buildQualifiedNameIndex(definitions),
        methodDispatch: buildMethodDispatchIndex({
          owners: [owner.nodeId],
          computeMro: () => [],
          implementsOf: () => [],
        }),
      } as ScopeResolutionIndexes;
      const model = createSemanticModel();
      for (const method of methods)
        model.methods.register(owner.nodeId, method.qualifiedName!.split('.')[1]!, method);
      setJavaOverloadFacts(filePath, facts);
      let reads = 0;
      for (const fact of facts.methods)
        for (const key of ['name', 'range', 'typeParameters'] as const) {
          const value = fact[key];
          Object.defineProperty(fact, key, {
            get() {
              reads++;
              return value;
            },
          });
        }
      for (const call of facts.calls) {
        expect(
          resolveJavaReceiverMember(
            owner,
            call.name,
            {
              inScope: 'class',
              kind: 'call',
              callForm: 'member',
              name: call.name,
              atRange: call.range,
              arity: 1,
            },
            scopes,
            model,
          ),
        ).toMatchObject(
          generic
            ? { kind: 'unknown' }
            : { kind: 'resolved', definition: { parameterTypes: ['String'] } },
        );
      }
      expect(reads).toBeLessThanOrEqual(facts.methods.length * 20);
    },
  );
});

describe('Java overload families with synthetic signature metadata', () => {
  it.each([
    { label: 'missing', types: undefined },
    { label: 'empty', types: [] },
    { label: 'inconsistent', types: ['int', 'int'] },
  ])(
    'retains singleton compatibility with $label types for one declared parameter',
    ({ types }) => {
      expect(resolveSynthetic([{ count: 1, types }])).toBeUndefined();
    },
  );

  it('keeps an overloaded family unknown when one formal signature is unavailable', () => {
    expect(resolveSynthetic([{ count: 1 }, { count: 1, types: ['int'] }])).toMatchObject({
      kind: 'unknown',
      candidateSetComplete: true,
    });
  });

  it('still rejects a call whose arity differs from the known declaration arity', () => {
    expect(resolveSynthetic([{ count: 1 }], 0)).toMatchObject({ kind: 'inapplicable' });
  });
});

describe('Java inherited overload inventory bounds', () => {
  it.each([12, 16])(
    'checks a depth-%i diamond without expanding every inheritance path',
    (depth) => {
      const declarations = ['interface A0 {}', 'interface B0 {}'];
      for (let level = 1; level <= depth; level++) {
        declarations.push(
          `interface A${level} extends A${level - 1}, B${level - 1} {}`,
          `interface B${level} extends A${level - 1}, B${level - 1} {}`,
        );
      }
      const fixture = hierarchyFixture(declarations, [`A${depth}`, `B${depth}`]);
      expect(fixture.resolve()).toMatchObject({
        kind: 'resolved',
        definition: { parameterTypes: ['Long'] },
      });
      expect(fixture.baseReads()).toBeLessThanOrEqual((declarations.length + 1) * 2);
    },
  );

  it.each([
    ['C1', 'C63'],
    ['C63', 'C1'],
  ])('does not reuse a shallow proof past the depth bound (%s, %s)', (first, second) => {
    const declarations = ['interface C0 {}'];
    for (let level = 1; level <= 63; level++)
      declarations.push(`interface C${level} extends C${level - 1} {}`);
    const fixture = hierarchyFixture(declarations, [first, second]);
    expect(fixture.resolve()).toMatchObject({
      kind: 'unknown',
      candidateSetComplete: false,
    });
  });

  it('retains cyclic-hierarchy uncertainty across repeated inventory requests', () => {
    const fixture = hierarchyFixture(
      ['interface Left extends Right {}', 'interface Right extends Left {}'],
      ['Left'],
    );
    for (let attempt = 0; attempt < 2; attempt++)
      expect(fixture.resolve()).toMatchObject({ kind: 'unknown', candidateSetComplete: false });
  });
});

describe('Java source subtype conversion bounds', () => {
  const conversion = { argumentType: 'Argument', parameterTypes: ['Unrelated', 'Object'] as const };

  it.each([12, 16])(
    'checks an unrelated formal through a depth-%i diamond once per type',
    (depth) => {
      const declarations = ['interface A0 {}', 'interface B0 {}'];
      for (let level = 1; level <= depth; level++) {
        declarations.push(
          `interface A${level} extends A${level - 1}, B${level - 1} {}`,
          `interface B${level} extends A${level - 1}, B${level - 1} {}`,
        );
      }
      declarations.push(`class Argument implements A${depth}, B${depth} {}`, 'class Unrelated {}');
      const fixture = hierarchyFixture(declarations, [], conversion);
      expect(fixture.resolve()).toMatchObject({
        kind: 'resolved',
        definition: { parameterTypes: ['Object'] },
      });
      expect(fixture.baseReads()).toBeLessThanOrEqual((declarations.length + 1) * 2);
    },
  );

  it.each([
    ['C1', 'C63'],
    ['C63', 'C1'],
  ])(
    'does not reuse a shallow subtype rejection beyond the depth bound (%s, %s)',
    (first, second) => {
      const declarations = ['interface C0 {}'];
      for (let level = 1; level <= 63; level++)
        declarations.push(`interface C${level} extends C${level - 1} {}`);
      declarations.push(`class Argument implements ${first}, ${second} {}`, 'class Unrelated {}');
      const fixture = hierarchyFixture(declarations, [], conversion);
      expect(fixture.resolve()).toMatchObject({ kind: 'unknown', candidateSetComplete: true });
    },
  );

  it('retains cyclic subtype uncertainty instead of selecting the Object fallback', () => {
    const fixture = hierarchyFixture(
      [
        'interface Left extends Right {}',
        'interface Right extends Left {}',
        'class Argument implements Left {}',
        'class Unrelated {}',
      ],
      [],
      conversion,
    );
    for (let attempt = 0; attempt < 2; attempt++)
      expect(fixture.resolve()).toMatchObject({ kind: 'unknown', candidateSetComplete: true });
  });
});
