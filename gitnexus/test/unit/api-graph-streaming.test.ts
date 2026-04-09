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

import {
  ClientDisconnectedError,
  streamGraphNdjson,
} from '../../src/server/api.js';

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
    lbugMocks.streamQuery.mockImplementation(async (query: string, onRow: (row: any) => Promise<void>) => {
      if (query.includes('MATCH (n:File)')) {
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
    });

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
    lbugMocks.streamQuery.mockImplementation(async (query: string, onRow: (row: any) => Promise<void>) => {
      if (!query.includes('MATCH (n:File)')) {
        return 0;
      }
      await onRow({ id: 'File:src/app.ts', name: 'app.ts', filePath: 'src/app.ts' });
      controller.abort();
      await onRow({ id: 'File:src/other.ts', name: 'other.ts', filePath: 'src/other.ts' });
      return 2;
    });

    const response = createMockResponse();

    await expect(streamGraphNdjson(response, false, controller.signal)).rejects.toBeInstanceOf(
      ClientDisconnectedError,
    );
    expect(response.write).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-missing table errors', async () => {
    lbugMocks.streamQuery.mockImplementation(async (query: string) => {
      if (query.includes('MATCH (n:File)')) {
        throw new Error('database unavailable');
      }
      return 0;
    });

    const response = createMockResponse();
    await expect(streamGraphNdjson(response, false)).rejects.toThrow('database unavailable');
  });

  it('ignores missing-table errors while continuing the stream', async () => {
    lbugMocks.streamQuery.mockImplementation(async (query: string, onRow: (row: any) => Promise<void>) => {
      if (query.includes('MATCH (n:File)')) {
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
    });

    const response = createMockResponse();
    await expect(streamGraphNdjson(response, false)).resolves.toBeUndefined();
    expect(response.write).toHaveBeenCalledTimes(1);
  });
});
