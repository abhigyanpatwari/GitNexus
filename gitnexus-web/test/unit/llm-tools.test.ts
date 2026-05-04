import { describe, expect, it, vi } from 'vitest';
import { createGraphRAGTools } from '../../src/core/llm/tools';
import { parseNodeMarker } from '../../src/lib/agent-tracking';

describe('Graph RAG tools', () => {
  it('emits graph markers from enriched search nodeIds arrays', async () => {
    const tools = createGraphRAGTools({
      executeQuery: vi.fn(),
      grep: vi.fn(),
      readFile: vi.fn(),
      search: vi.fn().mockResolvedValue([
        {
          filePath: 'src/GraphCanvas.tsx',
          score: 4.2,
          nodeIds: ['File:src/GraphCanvas.tsx', 'Function:src/GraphCanvas.tsx:GraphCanvas'],
        },
      ]),
    });
    const searchTool = tools.find((tool) => tool.name === 'search');

    const output = String(await searchTool?.invoke({ query: 'agent lens', limit: 1 }));

    expect(parseNodeMarker(output, 'HIGHLIGHT_NODES')).toEqual([
      'File:src/GraphCanvas.tsx',
      'Function:src/GraphCanvas.tsx:GraphCanvas',
    ]);
  });
});
