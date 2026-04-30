import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    executeQuery: vi.fn(),
    streamQuery: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

import {
  buildGraph,
  ClientDisconnectedError,
  isMissingGraphAnchorColumnError,
  streamGraphNdjson,
} from '../../src/server/api.js';

const createMockResponse = (writeImpl?: (chunk: string) => boolean) => {
  const response = new EventEmitter() as any;
  response.writableEnded = false;
  response.destroyed = false;
  response.write = vi.fn((chunk: string) => (writeImpl ? writeImpl(chunk) : true));
  return response;
};

const duplicateRelationshipRows = [
  {
    sourceId: 'Function:src/app.ts:main',
    targetId: 'Function:src/app.ts:save',
    type: 'CALLS',
    confidence: 0.53,
    reason: 'scope-resolution: call',
    step: 0,
  },
  {
    sourceId: 'Function:src/app.ts:main',
    targetId: 'Function:src/app.ts:save',
    type: 'CALLS',
    confidence: 0.85,
    reason: 'global',
    step: 0,
  },
  {
    sourceId: 'Function:src/app.ts:main',
    targetId: 'Function:src/app.ts:save',
    type: 'CALLS',
    confidence: 0.85,
    reason: 'global',
    step: 0,
  },
  {
    sourceId: 'Function:src/app.ts:main',
    targetId: 'Property:src/app.ts:User.name',
    type: 'ACCESSES',
    confidence: 1,
    reason: 'read',
    step: 0,
  },
  {
    sourceId: 'Function:src/app.ts:main',
    targetId: 'Property:src/app.ts:User.name',
    type: 'ACCESSES',
    confidence: 1,
    reason: 'write',
    step: 0,
  },
];

describe('streamGraphNdjson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for drain when writes hit backpressure', async () => {
    lbugMocks.streamQuery.mockImplementation(
      async (query: string, onRow: (row: any) => Promise<void>) => {
        if (query.includes('MATCH (n:`File`)')) {
          await onRow({ id: 'File:src/app.ts', name: 'app.ts', filePath: 'src/app.ts' });
          return 1;
        }
        if (query.includes('CodeRelation')) {
          await onRow({
            sourceId: 'File:src/app.ts',
            targetId: 'Function:src/app.ts:main',
            type: 'CONTAINS',
          });
          return 1;
        }
        return 0;
      },
    );

    const writes: string[] = [];
    let firstWrite = true;
    const response = createMockResponse((chunk) => {
      writes.push(chunk);
      if (firstWrite) {
        firstWrite = false;
        return false;
      }
      return true;
    });

    let settled = false;
    const pending = streamGraphNdjson(response, false).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(writes).toHaveLength(1);
    expect(settled).toBe(false);

    response.emit('drain');
    await pending;

    expect(writes).toHaveLength(2);
  });

  it('stops streaming when the client disconnects', async () => {
    const controller = new AbortController();
    lbugMocks.streamQuery.mockImplementation(
      async (query: string, onRow: (row: any) => Promise<void>) => {
        if (!query.includes('MATCH (n:`File`)')) {
          return 0;
        }
        await onRow({ id: 'File:src/app.ts', name: 'app.ts', filePath: 'src/app.ts' });
        controller.abort();
        await onRow({ id: 'File:src/other.ts', name: 'other.ts', filePath: 'src/other.ts' });
        return 2;
      },
    );

    const response = createMockResponse();

    await expect(streamGraphNdjson(response, false, controller.signal)).rejects.toBeInstanceOf(
      ClientDisconnectedError,
    );
    expect(response.write).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-missing table errors', async () => {
    lbugMocks.streamQuery.mockImplementation(async (query: string) => {
      if (query.includes('MATCH (n:`File`)')) {
        throw new Error('database unavailable');
      }
      return 0;
    });

    const response = createMockResponse();
    await expect(streamGraphNdjson(response, false)).rejects.toThrow('database unavailable');
  });

  it('ignores missing-table errors while continuing the stream', async () => {
    lbugMocks.streamQuery.mockImplementation(
      async (query: string, onRow: (row: any) => Promise<void>) => {
        if (query.includes('MATCH (n:`File`)')) {
          throw new Error('Table File does not exist');
        }
        if (query.includes('CodeRelation')) {
          await onRow({
            sourceId: 'File:src/app.ts',
            targetId: 'Function:src/app.ts:main',
            type: 'CONTAINS',
          });
          return 1;
        }
        return 0;
      },
    );

    const response = createMockResponse();
    await expect(streamGraphNdjson(response, false)).resolves.toBeUndefined();
    expect(response.write).toHaveBeenCalledTimes(1);
  });

  it('quotes node table names in generated Cypher queries', async () => {
    lbugMocks.streamQuery.mockImplementation(async () => 0);

    const response = createMockResponse();
    await expect(streamGraphNdjson(response, false)).resolves.toBeUndefined();

    expect(lbugMocks.streamQuery).toHaveBeenCalledWith(
      expect.stringContaining('MATCH (n:`Macro`)'),
      expect.any(Function),
    );
  });

  it('streams Route and Tool nodes without requiring startLine fields', async () => {
    lbugMocks.streamQuery.mockImplementation(
      async (query: string, onRow: (row: any) => Promise<void>) => {
        if (query.includes('MATCH (n:`Route`)')) {
          expect(query).not.toContain('startLine');
          await onRow({
            id: 'Route:/api/graph:GET',
            name: 'GET /api/graph',
            filePath: 'src/server/api.ts',
            responseKeys: ['nodes', 'relationships'],
            errorKeys: ['error'],
            middleware: ['withAuth'],
          });
          return 1;
        }
        if (query.includes('MATCH (n:`Tool`)')) {
          expect(query).not.toContain('startLine');
          await onRow({
            id: 'Tool:gitnexus_query',
            name: 'gitnexus_query',
            filePath: 'src/mcp/resources.ts',
            description: 'Query the code graph',
          });
          return 1;
        }
        return 0;
      },
    );

    const writes: string[] = [];
    const response = createMockResponse((chunk) => {
      writes.push(chunk);
      return true;
    });

    await expect(streamGraphNdjson(response, false)).resolves.toBeUndefined();

    const records = writes.map((chunk) => JSON.parse(chunk));
    expect(records).toContainEqual({
      type: 'node',
      data: {
        id: 'Route:/api/graph:GET',
        label: 'Route',
        properties: {
          name: 'GET /api/graph',
          filePath: 'src/server/api.ts',
          startLine: undefined,
          endLine: undefined,
          content: undefined,
          responseKeys: ['nodes', 'relationships'],
          errorKeys: ['error'],
          middleware: ['withAuth'],
          heuristicLabel: undefined,
          cohesion: undefined,
          symbolCount: undefined,
          description: undefined,
          processType: undefined,
          stepCount: undefined,
          communities: undefined,
          entryPointId: undefined,
          terminalId: undefined,
        },
      },
    });
    expect(records).toContainEqual({
      type: 'node',
      data: {
        id: 'Tool:gitnexus_query',
        label: 'Tool',
        properties: {
          name: 'gitnexus_query',
          filePath: 'src/mcp/resources.ts',
          startLine: undefined,
          endLine: undefined,
          content: undefined,
          responseKeys: undefined,
          errorKeys: undefined,
          middleware: undefined,
          heuristicLabel: undefined,
          cohesion: undefined,
          symbolCount: undefined,
          description: 'Query the code graph',
          processType: undefined,
          stepCount: undefined,
          communities: undefined,
          entryPointId: undefined,
          terminalId: undefined,
        },
      },
    });
  });

  it('streams semantic anchor metadata for code nodes', async () => {
    lbugMocks.streamQuery.mockImplementation(
      async (query: string, onRow: (row: any) => Promise<void>) => {
        if (query.includes('MATCH (n:`Function`)')) {
          expect(query).toContain('n.summary AS summary');
          await onRow({
            id: 'Function:src/auth.ts:authGate',
            name: 'authGate',
            filePath: 'src/auth.ts',
            startLine: 10,
            endLine: 18,
            description: 'Function authGate implements behavior in auth.ts.',
            summary: 'Function authGate implements behavior in auth.ts.',
            purpose: 'Use this behavior anchor to trace callers before editing.',
            tags: ['function', 'exported'],
            anchorModel: 'heuristic-v1',
            anchorHash: 'abc12345',
            anchorVersion: 1,
            anchorGeneratedAt: '2026-04-30T01:02:03.000Z',
          });
          return 1;
        }
        return 0;
      },
    );

    const writes: string[] = [];
    const response = createMockResponse((chunk) => {
      writes.push(chunk);
      return true;
    });

    await expect(streamGraphNdjson(response, false)).resolves.toBeUndefined();

    const records = writes.map((chunk) => JSON.parse(chunk));
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'node',
        data: expect.objectContaining({
          id: 'Function:src/auth.ts:authGate',
          properties: expect.objectContaining({
            summary: 'Function authGate implements behavior in auth.ts.',
            purpose: 'Use this behavior anchor to trace callers before editing.',
            tags: ['function', 'exported'],
            anchorModel: 'heuristic-v1',
            anchorHash: 'abc12345',
            anchorVersion: 1,
            anchorGeneratedAt: '2026-04-30T01:02:03.000Z',
          }),
        }),
      }),
    );
  });

  it('falls back to legacy node queries when anchor columns are absent', async () => {
    expect(
      isMissingGraphAnchorColumnError(new Error('Binder Error: property summary not found')),
    ).toBe(true);

    lbugMocks.executeQuery.mockImplementation(async (query: string) => {
      if (query.includes('MATCH (n:`Function`)') && query.includes('n.summary AS summary')) {
        throw new Error('Binder Error: property summary not found');
      }
      if (query.includes('MATCH (n:`Function`)')) {
        return [
          {
            id: 'Function:src/auth.ts:legacy',
            name: 'legacy',
            filePath: 'src/auth.ts',
            startLine: 1,
            endLine: 5,
            description: 'Legacy description',
          },
        ];
      }
      if (query.includes('CodeRelation')) return [];
      return [];
    });

    const graph = await buildGraph(false);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].properties.description).toBe('Legacy description');
    expect(graph.nodes[0].properties.summary).toBeUndefined();
  });

  it('deduplicates streamed relationships while keeping read and write access edges', async () => {
    lbugMocks.streamQuery.mockImplementation(
      async (query: string, onRow: (row: any) => Promise<void>) => {
        if (query.includes('CodeRelation')) {
          for (const row of duplicateRelationshipRows) await onRow(row);
          return duplicateRelationshipRows.length;
        }
        return 0;
      },
    );

    const writes: string[] = [];
    const response = createMockResponse((chunk) => {
      writes.push(chunk);
      return true;
    });

    await expect(streamGraphNdjson(response, false)).resolves.toBeUndefined();

    const records = writes.map((chunk) => JSON.parse(chunk));
    const relationships = records.filter((record) => record.type === 'relationship');
    expect(relationships).toHaveLength(3);

    const calls = relationships.filter((record) => record.data.type === 'CALLS');
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toMatchObject({ confidence: 0.85, reason: 'global' });

    const accessReasons = relationships
      .filter((record) => record.data.type === 'ACCESSES')
      .map((record) => record.data.reason)
      .sort();
    expect(accessReasons).toEqual(['read', 'write']);
  });

  it('deduplicates built graph relationships using the same relationship identity', async () => {
    lbugMocks.executeQuery.mockImplementation(async (query: string) => {
      if (query.includes('MATCH (n:`File`)')) {
        return [{ id: 'File:src/app.ts', name: 'app.ts', filePath: 'src/app.ts' }];
      }
      if (query.includes('CodeRelation')) return duplicateRelationshipRows;
      return [];
    });

    const graph = await buildGraph(false);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.relationships).toHaveLength(3);
    expect(graph.relationships.find((rel) => rel.type === 'CALLS')).toMatchObject({
      confidence: 0.85,
      reason: 'global',
    });
    expect(
      graph.relationships
        .filter((rel) => rel.type === 'ACCESSES')
        .map((rel) => rel.reason)
        .sort(),
    ).toEqual(['read', 'write']);
  });
});
