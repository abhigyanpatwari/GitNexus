import { describe, expect, it, vi } from 'vitest';

import type { SerializablePipelineResult } from '../types/pipeline';
import { buildPipelineResultFromSerialized, hydrateSerializedServerGraph } from './server-graph-hydration';

describe('server graph hydration helpers', () => {
  const serialized: SerializablePipelineResult = {
    nodes: [
      {
        id: 'file:src/foo.ts',
        label: 'File' as const,
        properties: {
          name: 'foo.ts',
          filePath: 'src/foo.ts',
          content: 'export function foo() {}',
        },
      },
      {
        id: 'func:src/foo.ts:foo',
        label: 'Function' as const,
        properties: {
          name: 'foo',
          filePath: 'src/foo.ts',
        },
      },
    ],
    relationships: [
      {
        source: 'file:src/foo.ts',
        target: 'func:src/foo.ts:foo',
        type: 'CONTAINS' as const,
        properties: { type: 'CONTAINS' },
      },
    ],
    fileContents: {
      'src/foo.ts': 'export function foo() {}',
    },
  };

  it('rebuilds a graph and file map from serialized server payloads', () => {
    const result = buildPipelineResultFromSerialized(serialized);

    expect(result.graph.nodeCount).toBe(2);
    expect(result.graph.relationshipCount).toBe(1);
    expect(result.fileContents.get('src/foo.ts')).toBe('export function foo() {}');
  });

  it('delegates the rebuilt result to the worker-side loader', async () => {
    const loadResult = vi.fn().mockResolvedValue(undefined);

    const result = await hydrateSerializedServerGraph(serialized, loadResult);

    expect(loadResult).toHaveBeenCalledTimes(1);
    expect(loadResult).toHaveBeenCalledWith(result);
    expect(result.graph.nodeCount).toBe(2);
    expect(result.fileContents.size).toBe(1);
  });
});
