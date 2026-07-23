import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MoveFactsMap } from '../../../src/core/move/compiler-facts.js';
import {
  makeMoveFlowClientStub,
  moveFunctionFact,
  runMoveIngestPhaseWithGraph,
} from '../../helpers/move-ingest-harness.js';

const REPO_ROOT = path.resolve('/repo');
const SOURCE_FILE = path.join(REPO_ROOT, 'pkg/sources/spot.move');

const facts: MoveFactsMap = {
  '0xa::spot_callbacks': {
    file: SOURCE_FILE,
    functions: [
      moveFunctionFact('make_callbacks', {
        file: SOURCE_FILE,
        span: [1, 4],
        visibility: 'public',
        params: [],
        returnTypes: ['|address|bool has copy + drop', '|address|bool has copy + drop'],
      }),
      moveFunctionFact('dispatch_funds', {
        file: SOURCE_FILE,
        span: [6, 8],
        params: [],
      }),
      moveFunctionFact('local_callback_user', {
        file: SOURCE_FILE,
        span: [9, 9],
        params: [],
      }),
      moveFunctionFact('withdrawal_done', {
        file: SOURCE_FILE,
        span: [10, 12],
        params: [],
      }),
      moveFunctionFact('complete', {
        file: SOURCE_FILE,
        span: [14, 16],
        params: [],
      }),
      moveFunctionFact('public_api', {
        file: SOURCE_FILE,
        span: [22, 25],
        visibility: 'public',
        params: [
          {
            name: 'object',
            type: '0x1::object::Object<0x1::fungible_asset::Metadata>',
          },
        ],
      }),
    ],
    structs: [],
    constants: [],
  },
};

async function ingestFixture() {
  const client = makeMoveFlowClientStub({
    facts: async () => facts,
    callGraph: async () => ({
      '0xa::spot_callbacks::make_callbacks': [],
      '0xa::spot_callbacks::withdrawal_done': ['0xa::spot_callbacks::complete'],
      '0xa::spot_callbacks::public_api': ['0x1::object::object_address'],
    }),
    functionUsage: async (_pkg, functionName) => {
      if (functionName === 'spot_callbacks::local_callback_user') {
        return {
          called: [],
          used: ['0xa::spot_callbacks::complete'],
        };
      }
      if (functionName === 'spot_callbacks::withdrawal_done') {
        // call_graph already carries withdrawal_done → complete; function_usage
        // reporting it as used-not-called must not mint a second CALLS edge.
        return { called: [], used: ['0xa::spot_callbacks::complete'] };
      }
      if (functionName !== 'spot_callbacks::make_callbacks') {
        return { called: [], used: [] };
      }
      return {
        called: [],
        used: ['0xa::spot_callbacks::dispatch_funds', '0xa::spot_callbacks::withdrawal_done'],
      };
    },
  });
  const { output, graph } = await runMoveIngestPhaseWithGraph(client, REPO_ROOT, [
    'pkg/Move.toml',
    'pkg/sources/spot.move',
  ]);
  const nodes = [...graph.iterNodes()];
  const edges = [...graph.iterRelationships()];
  const functionId = (qualifiedName: string) =>
    nodes.find(
      (node) => node.label === 'Function' && node.properties.qualifiedName === qualifiedName,
    )?.id;
  return { client, output, nodes, edges, functionId };
}

describe('Move graph quality regressions', () => {
  it('links compiler-reported closure captures for all ordinary functions', async () => {
    const { client, edges, functionId } = await ingestFixture();
    const makeCallbacks = functionId('0xa::spot_callbacks::make_callbacks');
    expect(
      edges.filter(
        (edge) =>
          edge.sourceId === makeCallbacks &&
          edge.type === 'CALLS' &&
          edge.reason === 'move-compiler-closure-use',
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: functionId('0xa::spot_callbacks::dispatch_funds'),
        }),
        expect.objectContaining({
          targetId: functionId('0xa::spot_callbacks::withdrawal_done'),
        }),
      ]),
    );
    expect(
      edges.some(
        (edge) =>
          edge.sourceId === functionId('0xa::spot_callbacks::local_callback_user') &&
          edge.targetId === functionId('0xa::spot_callbacks::complete') &&
          edge.type === 'CALLS' &&
          edge.reason === 'move-compiler-closure-use',
      ),
    ).toBe(true);
    expect(client.counts.functionUsage).toBe(facts['0xa::spot_callbacks'].functions?.length);
  });

  it('does not duplicate a call-graph edge the usage query classifies as a capture', async () => {
    const { edges, functionId } = await ingestFixture();
    const callEdges = edges.filter(
      (edge) =>
        edge.type === 'CALLS' &&
        edge.sourceId === functionId('0xa::spot_callbacks::withdrawal_done') &&
        edge.targetId === functionId('0xa::spot_callbacks::complete'),
    );

    expect(callEdges).toHaveLength(1);
    expect(callEdges[0].reason).toBe('move-compiler-call-graph');
  });

  it('materializes external function and type targets', async () => {
    const { output, nodes, edges, functionId } = await ingestFixture();
    const externalFunction = nodes.find(
      (node) =>
        node.label === 'Function' &&
        node.properties.qualifiedName === '0x1::object::object_address',
    );
    expect(externalFunction?.properties.locationFidelity).toBe('external');
    expect(
      edges.some(
        (edge) =>
          edge.type === 'CALLS' &&
          edge.sourceId === functionId('0xa::spot_callbacks::public_api') &&
          edge.targetId === externalFunction?.id,
      ),
    ).toBe(true);

    const externalTypes = nodes.filter(
      (node) => node.label === 'Type' && node.properties.locationFidelity === 'external',
    );
    expect(externalTypes.map((node) => node.properties.qualifiedName).sort()).toEqual([
      '0x1::fungible_asset::Metadata',
      '0x1::object::Object',
    ]);
    expect(
      edges.filter(
        (edge) =>
          edge.type === 'USES_TYPE' &&
          edge.sourceId === functionId('0xa::spot_callbacks::public_api'),
      ),
    ).toHaveLength(2);
    expect(output.droppedTypeRefs).toEqual([]);
  });
});
