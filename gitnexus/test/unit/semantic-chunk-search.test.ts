import { describe, expect, it, vi } from 'vitest';
import { collectBestChunks } from '../../src/core/embeddings/types.js';

describe('collectBestChunks', () => {
  it('keeps fetching until enough unique nodeIds are available', async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ({
        nodeId: 'Function:a',
        chunkIndex: i,
        startLine: 10 + i,
        endLine: 11 + i,
        distance: 0.1 + i * 0.01,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        nodeId: 'Function:b',
        chunkIndex: i,
        startLine: 20 + i,
        endLine: 21 + i,
        distance: 0.2 + i * 0.01,
      })),
      {
        nodeId: 'Function:c',
        chunkIndex: 0,
        startLine: 30,
        endLine: 31,
        distance: 0.3,
      },
      {
        nodeId: 'Function:d',
        chunkIndex: 0,
        startLine: 40,
        endLine: 41,
        distance: 0.4,
      },
    ];

    const fetchRows = vi.fn(async (fetchLimit: number) => rows.slice(0, fetchLimit));

    const bestChunks = await collectBestChunks(3, fetchRows);

    expect(fetchRows).toHaveBeenCalledTimes(2);
    expect(fetchRows).toHaveBeenNthCalledWith(1, 12);
    expect(fetchRows).toHaveBeenNthCalledWith(2, 24);
    expect(Array.from(bestChunks.keys()).slice(0, 3)).toEqual([
      'Function:a',
      'Function:b',
      'Function:c',
    ]);
  });

  it('continues fetching beyond the default 200-row window when unique nodes are still missing', async () => {
    const rows = [
      ...Array.from({ length: 200 }, (_, i) => ({
        nodeId: i < 120 ? 'Function:a' : 'Function:b',
        chunkIndex: i,
        startLine: i + 1,
        endLine: i + 2,
        distance: 0.01 + i * 0.001,
      })),
      {
        nodeId: 'Function:c',
        chunkIndex: 0,
        startLine: 500,
        endLine: 501,
        distance: 0.5,
      },
      {
        nodeId: 'Function:d',
        chunkIndex: 0,
        startLine: 600,
        endLine: 601,
        distance: 0.6,
      },
      {
        nodeId: 'Function:e',
        chunkIndex: 0,
        startLine: 700,
        endLine: 701,
        distance: 0.7,
      },
    ];

    const fetchRows = vi.fn(async (fetchLimit: number) => rows.slice(0, fetchLimit));

    const bestChunks = await collectBestChunks(5, fetchRows);

    expect(fetchRows).toHaveBeenCalledTimes(6);
    expect(fetchRows).toHaveBeenNthCalledWith(1, 20);
    expect(fetchRows).toHaveBeenNthCalledWith(2, 40);
    expect(fetchRows).toHaveBeenNthCalledWith(3, 80);
    expect(fetchRows).toHaveBeenNthCalledWith(4, 160);
    expect(fetchRows).toHaveBeenNthCalledWith(5, 200);
    expect(fetchRows).toHaveBeenNthCalledWith(6, 400);
    expect(Array.from(bestChunks.keys())).toEqual([
      'Function:a',
      'Function:b',
      'Function:c',
      'Function:d',
      'Function:e',
    ]);
  });

  it('stops when the vector search is exhausted before reaching the limit', async () => {
    const rows = [
      {
        nodeId: 'Function:a',
        chunkIndex: 0,
        startLine: 1,
        endLine: 2,
        distance: 0.1,
      },
      {
        nodeId: 'Function:a',
        chunkIndex: 1,
        startLine: 3,
        endLine: 4,
        distance: 0.2,
      },
      {
        nodeId: 'Function:b',
        chunkIndex: 0,
        startLine: 5,
        endLine: 6,
        distance: 0.3,
      },
    ];

    const fetchRows = vi.fn(async (_fetchLimit: number) => rows);

    const bestChunks = await collectBestChunks(5, fetchRows);

    expect(fetchRows).toHaveBeenCalledTimes(1);
    expect(Array.from(bestChunks.keys())).toEqual(['Function:a', 'Function:b']);
  });

  it('jumps to and continues past the 200-row window when needed for large limits', async () => {
    const rows = [
      ...Array.from({ length: 200 }, (_, i) => ({
        nodeId: `Function:${Math.floor(i / 50)}`,
        chunkIndex: i,
        startLine: i + 1,
        endLine: i + 2,
        distance: 0.01 + i * 0.001,
      })),
      ...Array.from({ length: 60 }, (_, i) => ({
        nodeId: `Function:extra-${i}`,
        chunkIndex: 0,
        startLine: 300 + i,
        endLine: 301 + i,
        distance: 1 + i * 0.001,
      })),
    ];

    const fetchRows = vi.fn(async (fetchLimit: number) => rows.slice(0, fetchLimit));

    const bestChunks = await collectBestChunks(60, fetchRows);

    expect(fetchRows).toHaveBeenNthCalledWith(1, 240);
    expect(fetchRows).toHaveBeenNthCalledWith(2, 480);
    expect(bestChunks.size).toBe(60);
  });
});
