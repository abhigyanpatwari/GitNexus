import { describe, it, expect } from 'vitest';
import { mapFactsToGraph } from '../../../src/core/move/facts-mapper.js';
import {
  buildLocalNameIndex,
  resolveRefs,
  ExternalMoveSymbols,
} from '../../../src/core/move/move-linker.js';
import type { DroppedRef } from '../../../src/core/move/refs.js';
import {
  type MoveFactsFunction,
  type MoveFactsMap,
} from '../../../src/core/move/compiler-facts.js';
import { moveFunctionFact } from '../../helpers/move-ingest-harness.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';

/** A fuller-shaped function facts entry (file/span/arrays) with per-test overrides. */
function fnFixture(name: string, overrides: Partial<MoveFactsFunction> = {}): MoveFactsFunction {
  return moveFunctionFact(name, {
    file: '/pkg/sources/fixture.move',
    span: [1, 3],
    visibility: 'public',
    attributes: [],
    typeParams: [],
    params: [],
    acquiresInferred: [],
    resourceAccess: { reads: [], writes: [] },
    isLambdaLifted: false,
    ...overrides,
  });
}

// Trimmed-but-faithful slice of a real `move_package_query { query: "facts" }`
// response for the `coin` fixture (coin + coin_admin modules).
const facts: MoveFactsMap = {
  '0xa::coin': {
    file: '/pkg/sources/coin.move',
    span: [1, 49],
    friends: [{ module: '0xa::coin_admin' }],
    attributes: [],
    functions: [
      {
        name: 'register',
        file: '/pkg/sources/coin.move',
        span: [19, 21],
        visibility: 'public',
        isEntry: true,
        isInline: false,
        isNative: false,
        isView: false,
        attributes: [],
        typeParams: [{ name: 'CoinType', abilities: [], isPhantom: false }],
        params: [{ name: 'account', type: '&signer' }],
        returnTypes: [],
        acquiresInferred: [],
        resourceAccess: { reads: [], writes: ['0xa::coin::CoinStore<CoinType>'] },
        isLambdaLifted: false,
      },
      {
        name: 'balance_of',
        file: '/pkg/sources/coin.move',
        span: [34, 37],
        visibility: 'public',
        isEntry: false,
        isInline: false,
        isNative: false,
        isView: true,
        attributes: [{ name: 'view' }],
        typeParams: [{ name: 'CoinType', abilities: [], isPhantom: false }],
        params: [{ name: 'addr', type: 'address' }],
        returnTypes: ['u64'],
        acquiresInferred: ['0xa::coin::CoinStore'],
        resourceAccess: { reads: ['0xa::coin::CoinStore<CoinType>'], writes: [] },
        isLambdaLifted: false,
      },
    ],
    structs: [
      {
        kind: 'struct',
        name: 'CoinStore',
        file: '/pkg/sources/coin.move',
        span: [5, 7],
        abilities: ['key'],
        typeParams: [{ name: 'CoinType', abilities: [], isPhantom: true }],
        fields: [{ name: 'balance', type: 'u64', positional: false }],
        attributes: [],
      },
      {
        kind: 'struct',
        name: 'TransferEvent',
        file: '/pkg/sources/coin.move',
        span: [10, 14],
        abilities: ['drop', 'store'],
        typeParams: [],
        fields: [{ name: 'amount', type: 'u64', positional: false }],
        attributes: [{ name: 'event' }],
      },
    ],
    constants: [{ name: 'E_NOT_REGISTERED', type: 'u64', value: '1' }],
  },
  '0xa::coin_admin': {
    file: '/pkg/sources/coin.move',
    span: [51, 55],
    friends: [],
    attributes: [],
    functions: [],
    structs: [],
    constants: [],
  },
};

function mapFactsToGraphWithResolvedEdges(factsMap: MoveFactsMap) {
  const mapped = mapFactsToGraph(factsMap, '/pkg');
  const graph = createKnowledgeGraph();
  for (const node of mapped.nodes) graph.addNode(node);
  for (const rel of mapped.edges) graph.addRelationship(rel);
  const localNameIndex = buildLocalNameIndex(mapped.structNodeMap);
  const external = new ExternalMoveSymbols(graph, mapped.moduleFileMap);
  const drops: DroppedRef[] = [];
  resolveRefs(
    graph,
    mapped.pendingRefs,
    {
      structNodeMap: mapped.structNodeMap,
      structIdsByLocalName: localNameIndex,
      moduleFileMap: mapped.moduleFileMap,
      functionNodeMap: mapped.functionNodeMap,
    },
    external,
    drops,
  );
  const edges = [...graph.iterRelationships()];
  const nodes = [...graph.iterNodes()];
  return { ...mapped, nodes, edges };
}

describe('mapFactsToGraph', () => {
  it('emits a WRITES_RESOURCE edge from register to CoinStore', () => {
    const { edges } = mapFactsToGraphWithResolvedEdges(facts);
    expect(
      edges.some(
        (e) =>
          e.type === 'WRITES_RESOURCE' &&
          e.sourceId.includes('register') &&
          e.targetId.includes('CoinStore'),
      ),
    ).toBe(true);
  });

  it('emits a READS_RESOURCE edge from balance_of to CoinStore', () => {
    const { edges } = mapFactsToGraphWithResolvedEdges(facts);
    expect(
      edges.some(
        (e) =>
          e.type === 'READS_RESOURCE' &&
          e.sourceId.includes('balance_of') &&
          e.targetId.includes('CoinStore'),
      ),
    ).toBe(true);
  });

  it('emits an ACQUIRES edge from the fully-qualified acquiresInferred name', () => {
    const { edges } = mapFactsToGraphWithResolvedEdges(facts);
    expect(edges.some((e) => e.type === 'ACQUIRES' && e.sourceId.includes('balance_of'))).toBe(
      true,
    );
  });

  it('emits a FRIEND_OF edge to coin_admin', () => {
    const { edges } = mapFactsToGraphWithResolvedEdges(facts);
    expect(edges.some((e) => e.type === 'FRIEND_OF' && e.targetId.includes('coin_admin'))).toBe(
      true,
    );
  });

  it('marks struct CoinStore as a resource (key ability)', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const cs = nodes.find((n) => n.properties.name === 'CoinStore');
    expect(cs?.label).toBe('Struct');
    expect(cs?.properties.isResource).toBe(true);
  });

  it('marks struct TransferEvent as an event (event attribute)', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const ev = nodes.find((n) => n.properties.name === 'TransferEvent');
    expect(ev?.properties.isEvent).toBe(true);
  });

  it('marks balance_of as a view entry point with precise location', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const fn = nodes.find((n) => n.properties.name === 'balance_of');
    expect(fn?.properties.isView).toBe(true);
    expect(fn?.properties.isExported).toBe(true);
    expect(fn?.properties.locationFidelity).toBe('precise');
    expect(fn?.properties.startLine).toBe(33);
  });

  it('maps public and compiler-marked entry/view functions onto isExported', () => {
    const visibilityFacts: MoveFactsMap = {
      '0xa::roots': {
        file: '/pkg/sources/roots.move',
        functions: [
          fnFixture('public_api', { visibility: 'public' }),
          fnFixture('package_api', { visibility: 'package' }),
          fnFixture('private_entry', { visibility: 'internal', isEntry: true }),
          fnFixture('init_module', { visibility: 'internal' }),
          fnFixture('helper', { visibility: 'internal' }),
        ],
      },
    };
    const { nodes } = mapFactsToGraph(visibilityFacts, '/pkg');
    const exported = (name: string) =>
      nodes.find((node) => node.label === 'Function' && node.properties.name === name)?.properties
        .isExported;

    expect(exported('public_api')).toBe(true);
    expect(exported('package_api')).toBe(false);
    expect(exported('private_entry')).toBe(true);
    expect(exported('init_module')).toBe(false);
    expect(exported('helper')).toBe(false);
  });

  it('tolerates functions/modules with missing optional arrays (real move-flow shape)', () => {
    // move-flow omits optional array fields (acquiresInferred, resourceAccess,
    // params, typeParams, attributes, friends, types, constants) for some symbols.
    // The mapper must not throw "not iterable" and skip the whole package.
    const sparse = {
      '0xb::sparse': {
        file: '/pkg/sources/sparse.move',
        // no friends / attributes / types / constants
        functions: [
          {
            name: 'do_thing',
            visibility: 'public',
            isEntry: true,
            isInline: false,
            isNative: false,
            isView: false,
            // acquiresInferred, resourceAccess, params, typeParams, attributes all absent
          },
        ],
      },
    };
    expect(() => mapFactsToGraph(sparse, '/pkg')).not.toThrow();
    const { nodes } = mapFactsToGraph(sparse, '/pkg');
    const fn = nodes.find((n) => n.properties.name === 'do_thing');
    expect(fn?.properties.isEntry).toBe(true);
    expect(fn?.properties.parameterCount).toBe(0);
    expect(fn?.properties.acquires).toEqual([]);
  });

  it('emits Module/Function/Struct/Const nodes and DEFINES edges', () => {
    const { nodes, edges, functionNodeMap, structNodeMap, moduleFileMap } = mapFactsToGraph(
      facts,
      '/pkg',
    );
    expect(nodes.some((n) => n.label === 'Module' && n.properties.name === 'coin')).toBe(true);
    expect(nodes.some((n) => n.label === 'Const' && n.properties.name === 'E_NOT_REGISTERED')).toBe(
      true,
    );
    expect(edges.some((e) => e.type === 'DEFINES')).toBe(true);
    expect(functionNodeMap.has('0xa::coin::register')).toBe(true);
    expect(structNodeMap.has('0xa::coin::CoinStore')).toBe(true);
    expect(moduleFileMap.get('0xa::coin')).toBe('/pkg/sources/coin.move');
  });

  it('uses the move-friend-or-package reason on FRIEND_OF edges (compiler-derived friends include package-visibility)', () => {
    const { edges } = mapFactsToGraphWithResolvedEdges(facts);
    const friendEdge = edges.find((e) => e.type === 'FRIEND_OF');
    expect(friendEdge?.reason).toBe('move-friend-or-package');
  });

  it('serializes Struct typeParams as typeParamsJson string', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const cs = nodes.find((n) => n.label === 'Struct' && n.properties.name === 'CoinStore');
    expect(cs?.properties.typeParamsJson).toBe(
      JSON.stringify([{ name: 'CoinType', constraints: [], isPhantom: true }]),
    );
    expect(cs?.properties.typeParams).toBeUndefined();
  });

  it('serializes Enum typeParams as typeParamsJson string', () => {
    const enumFacts: MoveFactsMap = {
      '0xa::orders': {
        file: '/pkg/sources/orders.move',
        friends: [],
        attributes: [],
        functions: [],
        structs: [
          {
            kind: 'enum',
            name: 'OrderState',
            file: '/pkg/sources/orders.move',
            span: [1, 5],
            abilities: ['drop'],
            typeParams: [{ name: 'T', abilities: ['copy'], isPhantom: false }],
            variants: [{ name: 'Open', kind: 'unit', fields: [], attributes: [] }],
            attributes: [],
          },
        ],
        constants: [],
      },
    };
    const { nodes } = mapFactsToGraph(enumFacts, '/pkg');
    const en = nodes.find((n) => n.label === 'Enum');
    expect(en?.properties.typeParamsJson).toBe(
      JSON.stringify([{ name: 'T', constraints: ['copy'], isPhantom: false }]),
    );
    expect(en?.properties.typeParams).toBeUndefined();
  });

  it('marks key enums as resources', () => {
    const enumFacts: MoveFactsMap = {
      '0xa::accounts': {
        file: '/pkg/sources/accounts.move',
        friends: [],
        attributes: [],
        functions: [],
        structs: [
          {
            kind: 'enum',
            name: 'GlobalAccountStates',
            file: '/pkg/sources/accounts.move',
            span: [1, 5],
            abilities: ['key'],
            typeParams: [],
            variants: [{ name: 'Empty', kind: 'unit', fields: [], attributes: [] }],
            attributes: [],
          },
        ],
        constants: [],
      },
    };
    const { nodes } = mapFactsToGraph(enumFacts, '/pkg');
    const en = nodes.find((n) => n.label === 'Enum' && n.properties.name === 'GlobalAccountStates');
    expect(en?.properties.isResource).toBe(true);
  });

  it('exposes EnumVariant attributes on the node', () => {
    const enumFacts: MoveFactsMap = {
      '0xa::orders': {
        file: '/pkg/sources/orders.move',
        friends: [],
        attributes: [],
        functions: [],
        structs: [
          {
            kind: 'enum',
            name: 'OrderState',
            file: '/pkg/sources/orders.move',
            span: [1, 5],
            abilities: [],
            typeParams: [],
            variants: [
              {
                name: 'Cancelled',
                kind: 'unit',
                fields: [],
                attributes: [{ name: 'deprecated' }],
              },
            ],
            attributes: [],
          },
        ],
        constants: [],
      },
    };
    const { nodes } = mapFactsToGraph(enumFacts, '/pkg');
    const v = nodes.find((n) => n.label === 'EnumVariant');
    expect(v?.properties.attributes).toEqual(['deprecated']);
    expect(v?.properties.locationFidelity).toBe('module');
  });

  it('materializes Move 2 enum variant fields and their local type edges', () => {
    const enumFacts: MoveFactsMap = {
      '0xa::orders': {
        file: '/pkg/sources/orders.move',
        functions: [],
        structs: [
          {
            kind: 'struct',
            name: 'Payload',
            file: '/pkg/sources/orders.move',
            span: [1, 2],
            abilities: ['copy'],
            typeParams: [],
            fields: [],
            attributes: [],
          },
          {
            kind: 'enum',
            name: 'OrderState',
            file: '/pkg/sources/orders.move',
            span: [4, 10],
            abilities: ['drop'],
            typeParams: [{ name: 'T', abilities: [], isPhantom: false }],
            variants: [
              {
                name: 'Open',
                kind: 'named',
                fields: [
                  { name: 'payload', type: 'Payload', positional: false },
                  { name: 'callback', type: '|Payload|T has copy + drop', positional: false },
                ],
                attributes: [],
              },
            ],
            attributes: [],
          },
        ],
      },
    };
    const { nodes, edges, pendingRefs } = mapFactsToGraphWithResolvedEdges(enumFacts);
    const variant = nodes.find(
      (node) => node.label === 'EnumVariant' && node.properties.name === 'Open',
    );
    const fieldIds = new Set(
      edges
        .filter((edge) => edge.type === 'HAS_PROPERTY' && edge.sourceId === variant?.id)
        .map((edge) => edge.targetId),
    );
    const fields = nodes.filter((node) => node.label === 'Property' && fieldIds.has(node.id));

    expect(fields.map((field) => field.properties.name)).toEqual(['payload', 'callback']);
    expect(
      edges.filter((edge) => edge.type === 'HAS_PROPERTY' && edge.sourceId === variant?.id),
    ).toHaveLength(2);
    expect(
      edges.some(
        (edge) =>
          edge.type === 'USES_TYPE' &&
          edge.reason === 'move-enum-variant-field-type' &&
          edge.sourceId === fields.find((field) => field.properties.name === 'callback')?.id &&
          edge.targetId.includes('Payload'),
      ),
    ).toBe(true);
    const typeRefs = pendingRefs.filter((r) => r.kind === 'type');
    expect(typeRefs.some((pending) => pending.target === 'copy')).toBe(false);
    expect(typeRefs.some((pending) => pending.target === 'drop')).toBe(false);
    expect(typeRefs.some((pending) => pending.target === 'T')).toBe(false);
  });

  it('does not write moduleAddress on Function nodes (only Module/Struct/Enum carry it)', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const fn = nodes.find((n) => n.label === 'Function' && n.properties.name === 'register');
    expect(fn?.properties.moduleAddress).toBeUndefined();
    const mod = nodes.find((n) => n.label === 'Module' && n.properties.name === 'coin');
    expect(mod?.properties.moduleAddress).toBe('0xa');
    const cs = nodes.find((n) => n.label === 'Struct' && n.properties.name === 'CoinStore');
    expect(cs?.properties.moduleAddress).toBe('0xa');
  });

  it('writes Const data under constType/constValue (matching schema column names)', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const c = nodes.find((n) => n.label === 'Const' && n.properties.name === 'E_NOT_REGISTERED');
    expect(c?.properties.constType).toBe('u64');
    expect(c?.properties.constValue).toBe('1');
    expect(c?.properties.declaredType).toBeUndefined();
    expect(c?.properties.value).toBeUndefined();
    expect(c?.properties.locationFidelity).toBe('module');
  });

  it('emits USES_TYPE edges from function signature types (params + return)', () => {
    const sigFacts: MoveFactsMap = {
      '0xa::coin': {
        file: '/pkg/sources/coin.move',
        friends: [],
        attributes: [],
        functions: [
          {
            name: 'wrap',
            file: '/pkg/sources/coin.move',
            span: [1, 5],
            visibility: 'public',
            isEntry: false,
            isInline: false,
            isNative: false,
            isView: false,
            attributes: [],
            typeParams: [],
            params: [{ name: 'store', type: '&CoinStore' }],
            returnTypes: ['TransferEvent'],
            acquiresInferred: [],
            resourceAccess: { reads: [], writes: [] },
          },
        ],
        structs: [
          {
            kind: 'struct',
            name: 'CoinStore',
            file: '/pkg/sources/coin.move',
            span: [10, 12],
            abilities: ['key'],
            typeParams: [],
            fields: [],
            attributes: [],
          },
          {
            kind: 'struct',
            name: 'TransferEvent',
            file: '/pkg/sources/coin.move',
            span: [20, 22],
            abilities: ['drop'],
            typeParams: [],
            fields: [],
            attributes: [],
          },
        ],
        constants: [],
      },
    };
    const { edges } = mapFactsToGraphWithResolvedEdges(sigFacts);
    const usesEdges = edges.filter((e) => e.type === 'USES_TYPE');
    const toCoinStore = usesEdges.find((e) => e.targetId.includes('CoinStore'));
    const toEvent = usesEdges.find((e) => e.targetId.includes('TransferEvent'));
    expect(toCoinStore?.reason).toBe('move-fn-param-type');
    expect(toEvent?.reason).toBe('move-fn-return-type');
  });

  it('populates usedTypes from resolved signature type edges only', () => {
    const sigFacts: MoveFactsMap = {
      '0xa::coin': {
        file: '/pkg/sources/coin.move',
        friends: [],
        attributes: [],
        functions: [
          {
            name: 'wrap',
            file: '/pkg/sources/coin.move',
            span: [1, 5],
            visibility: 'public',
            isEntry: false,
            isInline: false,
            isNative: false,
            isView: false,
            attributes: [],
            typeParams: [],
            params: [
              { name: 'stores', type: 'vector<CoinStore<T>>' },
              { name: 'unknown', type: 'UnresolvedType' },
            ],
            returnTypes: ['u64', 'TransferEvent'],
            acquiresInferred: [],
            resourceAccess: { reads: [], writes: [] },
          },
        ],
        structs: [
          {
            kind: 'struct',
            name: 'CoinStore',
            file: '/pkg/sources/coin.move',
            span: [10, 12],
            abilities: ['key'],
            typeParams: [],
            fields: [],
            attributes: [],
          },
          {
            kind: 'struct',
            name: 'TransferEvent',
            file: '/pkg/sources/coin.move',
            span: [20, 22],
            abilities: ['drop'],
            typeParams: [],
            fields: [],
            attributes: [],
          },
        ],
        constants: [],
      },
    };
    const { nodes } = mapFactsToGraphWithResolvedEdges(sigFacts);
    const wrap = nodes.find((n) => n.label === 'Function' && n.properties.name === 'wrap');
    expect(wrap?.properties.usedTypes).toEqual([
      '0xa::coin::CoinStore',
      '0xa::coin::TransferEvent',
    ]);
  });

  it('populates usedTypes string array on the Function node', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const balanceOf = nodes.find(
      (n) => n.label === 'Function' && n.properties.name === 'balance_of',
    );
    expect(balanceOf?.properties.usedTypes).toEqual([]);
    const register = nodes.find((n) => n.label === 'Function' && n.properties.name === 'register');
    expect(register?.properties.usedTypes).toEqual([]);
  });

  it('does not write isTest/isTestOnly on Function nodes (move-flow strips test items)', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const fn = nodes.find((n) => n.label === 'Function' && n.properties.name === 'balance_of');
    expect(fn?.properties.isTest).toBeUndefined();
    expect(fn?.properties.isTestOnly).toBeUndefined();
  });

  it('projects returnTypes onto the scalar returnType column ([] -> undefined, single -> element, tuple -> joined)', () => {
    const rtFacts: MoveFactsMap = {
      '0xa::rt': {
        file: '/pkg/sources/rt.move',
        friends: [],
        attributes: [],
        functions: [
          fnFixture('none', { returnTypes: [] }),
          fnFixture('single', { returnTypes: ['u64'] }),
          fnFixture('tuple', { returnTypes: ['u64', '0xbeef::price::PriceInfo'] }),
        ],
        structs: [],
        constants: [],
      },
    };
    const { nodes } = mapFactsToGraph(rtFacts, '/pkg');
    const byName = (name: string) => nodes.find((n) => n.properties.name === name);
    expect(byName('none')?.properties.returnType).toBeUndefined();
    expect(byName('single')?.properties.returnType).toBe('u64');
    expect(byName('tuple')?.properties.returnType).toBe('(u64, 0xbeef::price::PriceInfo)');
  });

  it('queues one move-fn-return-type ref per tuple element', () => {
    const rtFacts: MoveFactsMap = {
      '0xa::rt': {
        file: '/pkg/sources/rt.move',
        friends: [],
        attributes: [],
        functions: [fnFixture('snapshot', { returnTypes: ['u64', '0xbeef::price::PriceInfo'] })],
        structs: [],
        constants: [],
      },
    };
    const { pendingRefs } = mapFactsToGraph(rtFacts, '/pkg');
    const returnRefs = pendingRefs.filter(
      (p) => p.kind === 'type' && p.reason === 'move-fn-return-type',
    );
    expect(returnRefs.map((p) => p.target)).toEqual(['0xbeef::price::PriceInfo']);
  });

  it('rejects the legacy scalar returnType shape with a userActionable error (shape sentinel)', () => {
    const legacy = {
      '0xa::old': {
        file: '/pkg/sources/old.move',
        functions: [{ ...fnFixture('legacy'), returnTypes: undefined, returnType: 'u64' }],
      },
    } as unknown as MoveFactsMap;
    let caught: unknown;
    try {
      mapFactsToGraph(legacy, '/pkg');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('returnTypes');
    expect((caught as { userActionable?: boolean }).userActionable).toBe(true);
  });

  it('does not bind a qualified ref with no exact match to a same-named struct under a different address', () => {
    // Dependency-only 0x1::coin::CoinStore must NOT resolve to the repo's
    // 0xa::coin::CoinStore just because the bare names collide.
    const qualFacts: MoveFactsMap = {
      '0xa::coin': {
        file: '/pkg/sources/coin.move',
        friends: [],
        attributes: [],
        functions: [
          fnFixture('probe', {
            acquiresInferred: ['0x1::coin::CoinStore'],
            resourceAccess: { reads: ['0x1::coin::CoinStore'], writes: [] },
          }),
        ],
        structs: [
          {
            kind: 'struct',
            name: 'CoinStore',
            file: '/pkg/sources/coin.move',
            span: [1, 3],
            abilities: ['key'],
            typeParams: [],
            fields: [],
            attributes: [],
          },
        ],
        constants: [],
      },
    };
    const mapped = mapFactsToGraph(qualFacts, '/pkg');
    const graph = createKnowledgeGraph();
    for (const node of mapped.nodes) graph.addNode(node);
    for (const rel of mapped.edges) graph.addRelationship(rel);
    const localNameIndex = buildLocalNameIndex(mapped.structNodeMap);
    const external = new ExternalMoveSymbols(graph, mapped.moduleFileMap);
    const drops: DroppedRef[] = [];
    const resourceRefs = mapped.pendingRefs.filter((r) => r.kind === 'resource');
    resolveRefs(
      graph,
      resourceRefs,
      {
        structNodeMap: mapped.structNodeMap,
        structIdsByLocalName: localNameIndex,
        moduleFileMap: mapped.moduleFileMap,
        functionNodeMap: mapped.functionNodeMap,
      },
      external,
      drops,
    );
    const localCoinStoreId = mapped.structNodeMap.get('0xa::coin::CoinStore');
    const resolvedResourceEdges = [...graph.iterRelationships()].filter(
      (e) => e.type === 'READS_RESOURCE' || e.type === 'WRITES_RESOURCE' || e.type === 'ACQUIRES',
    );
    expect(resolvedResourceEdges.every((e) => e.targetId !== localCoinStoreId)).toBe(true);
    expect(resolvedResourceEdges.every((e) => e.targetId.includes('0x1::coin::CoinStore'))).toBe(
      true,
    );
  });

  it('projects full attribute payloads (args/values) as attributesJson alongside the name list', () => {
    const attrFacts: MoveFactsMap = {
      '0xa::vault': {
        file: '/pkg/sources/vault.move',
        friends: [],
        attributes: [],
        functions: [
          fnFixture('is_big', {
            attributes: [{ name: 'lint::skip', args: [{ name: 'needless_bool' }] }],
          }),
        ],
        structs: [
          {
            kind: 'struct',
            name: 'Group',
            file: '/pkg/sources/vault.move',
            span: [1, 1],
            abilities: [],
            typeParams: [],
            fields: [],
            attributes: [{ name: 'resource_group', args: [{ name: 'scope', value: 'global' }] }],
          },
        ],
        constants: [],
      },
    };
    const { nodes } = mapFactsToGraph(attrFacts, '/pkg');
    const fn = nodes.find((n) => n.label === 'Function' && n.properties.name === 'is_big');
    expect(fn?.properties.attributes).toEqual(['lint::skip']);
    expect(fn?.properties.attributesJson).toBe(
      JSON.stringify([{ name: 'lint::skip', args: [{ name: 'needless_bool' }] }]),
    );
    const group = nodes.find((n) => n.label === 'Struct' && n.properties.name === 'Group');
    expect(group?.properties.attributesJson).toBe(
      JSON.stringify([{ name: 'resource_group', args: [{ name: 'scope', value: 'global' }] }]),
    );
  });

  it('emits a resource-group membership USES_TYPE edge from resource_group_member(group = ...)', () => {
    const groupFacts: MoveFactsMap = {
      '0xa::vault': {
        file: '/pkg/sources/vault.move',
        friends: [],
        attributes: [],
        functions: [],
        structs: [
          {
            kind: 'struct',
            name: 'Group',
            file: '/pkg/sources/vault.move',
            span: [1, 1],
            abilities: [],
            typeParams: [],
            fields: [],
            attributes: [{ name: 'resource_group', args: [{ name: 'scope', value: 'global' }] }],
          },
          {
            kind: 'struct',
            name: 'Meta',
            file: '/pkg/sources/vault.move',
            span: [3, 5],
            abilities: ['key'],
            typeParams: [],
            fields: [],
            attributes: [
              {
                name: 'resource_group_member',
                args: [{ name: 'group', value: '0xa::vault::Group' }],
              },
            ],
          },
        ],
        constants: [],
      },
    };
    const { edges } = mapFactsToGraphWithResolvedEdges(groupFacts);
    const membership = edges.find((e) => e.reason === 'move-resource-group-member');
    expect(membership?.type).toBe('USES_TYPE');
    expect(membership?.sourceId).toContain('Meta');
    expect(membership?.targetId).toContain('Group');
  });

  it('prefers the compiler-reported definedIn over name parsing for lambda hosts', () => {
    const lambdaFacts: MoveFactsMap = {
      '0xa::vault': {
        file: '/pkg/sources/vault.move',
        friends: [],
        attributes: [],
        functions: [
          fnFixture('lifted'),
          fnFixture('__lambda__1__lifted', { isLambdaLifted: true, definedIn: 'lifted' }),
          // Nested closure: the name parse would yield '__lambda__1__outer',
          // but move-flow resolves the host through nested closures.
          fnFixture('__lambda__2____lambda__1__outer', {
            isLambdaLifted: true,
            definedIn: 'outer',
          }),
        ],
        structs: [],
        constants: [],
      },
    };
    const { pendingRefs } = mapFactsToGraph(lambdaFacts, '/pkg');
    const lambdaRefs = pendingRefs.filter((r) => r.kind === 'lambda-host');
    expect(lambdaRefs.map((p) => p.target)).toEqual(['0xa::vault::lifted', '0xa::vault::outer']);
  });

  it('attributes lifted lambdas to their declaring module source', () => {
    const lambdaFacts: MoveFactsMap = {
      '0xa::vault': {
        file: '/pkg/sources/vault.move',
        functions: [
          fnFixture('__lambda__1__run', {
            file: '/external/aptos-framework/sources/big_ordered_map.move',
            isLambdaLifted: true,
            definedIn: 'run',
          }),
        ],
      },
    };
    const { nodes } = mapFactsToGraph(lambdaFacts, '/pkg');
    const lambda = nodes.find(
      (node) => node.label === 'Function' && node.properties.name === '__lambda__1__run',
    );
    expect(lambda?.properties.filePath).toBe('/pkg/sources/vault.move');
    expect(lambda?.properties.startLine).toBeUndefined();
    expect(lambda?.properties.endLine).toBeUndefined();
    expect(lambda?.properties.locationFidelity).toBe('module');
  });
});
