import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    streamQuery: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

import { ClientDisconnectedError, streamGraphNdjson } from '../../src/server/api.js';

const createMockResponse = (writeImpl?: (chunk: string) => boolean) => {
  const response = new EventEmitter() as any;
  response.writableEnded = false;
  response.destroyed = false;
  response.write = vi.fn((chunk: string) => (writeImpl ? writeImpl(chunk) : true));
  return response;
};

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

  // Taint/PDG substrate (#2080): BasicBlock has no name/content columns, so its
  // getNodeQuery projects none — mapGraphNodeRow must still yield a `string`
  // name (NodeProperties.name contract) or the web layer derefs undefined.
  it('emits a string name for BasicBlock nodes (no name column)', async () => {
    lbugMocks.streamQuery.mockImplementation(
      async (query: string, onRow: (row: any) => Promise<void>) => {
        if (query.includes('MATCH (n:`BasicBlock`)')) {
          expect(query).not.toContain('n.name'); // BasicBlock projects no name column
          await onRow({
            id: 'BasicBlock:src/a.ts:0',
            filePath: 'src/a.ts',
            startLine: 1,
            endLine: 3,
            text: 'const x = req.body;',
          });
          // a block with no text must still map to a string name, not undefined
          await onRow({
            id: 'BasicBlock:src/a.ts:1',
            filePath: 'src/a.ts',
            startLine: 4,
            endLine: 4,
          });
          return 2;
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

    const blocks = writes
      .map((chunk) => JSON.parse(chunk))
      .filter((r) => r.type === 'node' && r.data.label === 'BasicBlock');
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      expect(typeof b.data.properties.name).toBe('string'); // never undefined
    }
    // falls back to the block text when present, else the empty-string floor
    expect(blocks[0].data.properties.name).toBe('const x = req.body;');
    expect(blocks[0].data.properties.text).toBe('const x = req.body;');
    expect(blocks[1].data.properties.name).toBe('');
  });
});
