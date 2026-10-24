// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';

import { sanitizeMermaidDiagram } from '../../src/core/wiki/mermaid-sanitizer.js';

// Parser-backed checks (#3705): the sanitizer's output is parsed by the
// Mermaid release the wiki viewer loads, and the graph it yields is compared,
// not just the parse result. jsdom stands in for the browser Mermaid expects.

type Graph = { nodes: string[]; edges: string[] };

async function parseFlowchart(diagram: string): Promise<Graph> {
  const parsed = await mermaid.mermaidAPI.getDiagramFromText(diagram);
  const db = parsed.db as {
    getVertices(): Map<string, { id: string }>;
    getEdges(): Array<{ start: string; end: string }>;
  };
  return {
    nodes: [...db.getVertices().keys()],
    edges: db.getEdges().map((edge) => `${edge.start}->${edge.end}`),
  };
}

describe('sanitizeMermaidDiagram, checked with the Mermaid parser', () => {
  mermaid.initialize({ startOnLoad: false });

  it('keeps the three diagrams from the report unchanged and valid', async () => {
    const diagrams = [
      'flowchart TD\n    A["value.when(...)"] -->|data| B["data"]',
      'flowchart TD\n    G["x = compute(...).result"] --> H["done"]',
      'flowchart LR\n    N -- ref.invalidate --> A',
    ];

    for (const diagram of diagrams) {
      expect(sanitizeMermaidDiagram(diagram)).toBe(diagram);
      await expect(parseFlowchart(diagram)).resolves.toBeTruthy();
    }
  });

  it('leaves rounded, circular and other shaped nodes alone at both ends of a link', async () => {
    const diagrams = [
      'flowchart LR\n    A(Start) --> B',
      'flowchart LR\n    X --> Y(Done)',
      'flowchart LR\n    A((Start)) --> B(End)',
      'flowchart LR\n    A[(db)] --> B{Choice} --> C>flag]',
      'flowchart LR\n    A([Stadium]) -->|yes| B[[Sub]]',
    ];

    for (const diagram of diagrams) {
      const sanitized = sanitizeMermaidDiagram(diagram);
      expect(sanitized).toBe(diagram);
      expect(await parseFlowchart(sanitized)).toEqual(await parseFlowchart(diagram));
    }
  });

  it('aliases every reference of a node in a chained link, plain and thick', async () => {
    const plain = ['flowchart LR', '    A --- file.ts --- B', '    file.ts --> C'].join('\n');
    const thick = ['flowchart LR', '    A === file.ts === B', '    file.ts ==> C'].join('\n');

    for (const diagram of [plain, thick]) {
      const original = await parseFlowchart(diagram);
      const graph = await parseFlowchart(sanitizeMermaidDiagram(diagram));
      // One node, under one id, with the same links as before.
      expect(graph.nodes).toEqual(['A', 'file_ts', 'B', 'C']);
      expect(graph.edges).toEqual(['A->file_ts', 'file_ts->B', 'file_ts->C']);
      expect(graph.edges).toHaveLength(original.edges.length);
    }
  });

  it('keeps labelled links written without spaces, and links with a cross or circle head', async () => {
    const spaced = 'flowchart LR\n    A --text--> B\n    B ==text==> C\n    C -.text.-> D';
    expect(sanitizeMermaidDiagram(spaced)).toBe(spaced);
    expect((await parseFlowchart(spaced)).edges).toEqual(['A->B', 'B->C', 'C->D']);

    const heads = 'flowchart LR\n    A --x B --> C\n    C --o D\n    D x--x E';
    expect(sanitizeMermaidDiagram(heads)).toBe(heads);
    expect((await parseFlowchart(heads)).edges).toEqual(['A->B', 'B->C', 'C->D', 'D->E']);
  });

  it('still repairs a call-shaped node id', async () => {
    const sanitized = sanitizeMermaidDiagram('flowchart LR\n    doc() --> B');

    expect(sanitized).toBe('flowchart LR\n    doc["doc()"] --> B');
    expect((await parseFlowchart(sanitized)).edges).toEqual(['doc->B']);
  });

  it('keeps the text of a labelled link and the graph around it', async () => {
    const diagram = ['flowchart LR', '    cache.ts -- ref.invalidate --> store.ts'].join('\n');

    const graph = await parseFlowchart(sanitizeMermaidDiagram(diagram));

    expect(graph.nodes).toEqual(['cache_ts', 'store_ts']);
    expect(graph.edges).toEqual(['cache_ts->store_ts']);
  });
});
