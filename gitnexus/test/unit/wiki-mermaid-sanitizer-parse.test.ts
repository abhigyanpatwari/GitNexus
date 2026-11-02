// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { sanitizeMermaidDiagram } from '../../src/core/wiki/mermaid-sanitizer.js';

// The official tiny browser bundle includes the same flowchart parser as the
// viewer's Mermaid 11, without installing the full renderer dependency tree.
// It is a script, not an importable module; execute it as a browser script in
// this test fork's jsdom environment. Nothing here ships with the CLI.
const require = createRequire(import.meta.url);
runInThisContext(readFileSync(require.resolve('@mermaid-js/tiny'), 'utf8'));
const mermaid = (
  globalThis as unknown as {
    mermaid: {
      initialize(config: { startOnLoad: boolean }): void;
      mermaidAPI: { getDiagramFromText(text: string): Promise<{ db: unknown }> };
    };
  }
).mermaid;

type Graph = {
  nodes: string[];
  edges: string[];
  labels: Array<{ text: string; type: string }>;
  links: Array<{ text: string; type: string; stroke: string }>;
};

async function parseFlowchart(diagram: string): Promise<Graph> {
  const parsed = await mermaid.mermaidAPI.getDiagramFromText(diagram);
  const db = parsed.db as {
    getVertices(): Map<string, { id: string; text: string; type: string }>;
    getEdges(): Array<{ start: string; end: string; text: string; type: string; stroke: string }>;
  };
  return {
    nodes: [...db.getVertices().keys()],
    edges: db.getEdges().map((edge) => `${edge.start}->${edge.end}`),
    labels: [...db.getVertices().values()].map(({ text, type }) => ({ text, type })),
    links: db.getEdges().map(({ text, type, stroke }) => ({ text, type, stroke })),
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

  it('reads a compact cross or circle link as a link, so the node after it is aliased too', async () => {
    const cross = ['flowchart LR', '    A --xfile.ts --> B', '    file.ts --> C'].join('\n');
    const circle = ['flowchart LR', '    A --ofile.ts --> B', '    file.ts --> C'].join('\n');

    for (const diagram of [cross, circle]) {
      const graph = await parseFlowchart(sanitizeMermaidDiagram(diagram));
      expect(graph.nodes).toEqual(['A', 'file_ts', 'B', 'C']);
      expect(graph.edges).toEqual(['A->file_ts', 'file_ts->B', 'file_ts->C']);
    }
  });

  it('still repairs a call-shaped node id', async () => {
    const sanitized = sanitizeMermaidDiagram('flowchart LR\n    doc() --> B');

    expect(sanitized).toBe('flowchart LR\n    doc["doc()"] --> B');
    expect((await parseFlowchart(sanitized)).edges).toEqual(['doc->B']);
  });

  it('repairs a qualified call-shaped id as one node, at either end of a link', async () => {
    const diagram = ['flowchart LR', '    foo().bar --> B', '    A --> foo().bar'].join('\n');

    const sanitized = sanitizeMermaidDiagram(diagram);
    const graph = await parseFlowchart(sanitized);

    expect(sanitized).toContain('foo___bar["foo().bar"] --> B');
    expect(sanitized).toContain('A --> foo___bar["foo().bar"]');
    expect(graph.nodes).toEqual(['foo___bar', 'B', 'A']);
    expect(graph.edges).toEqual(['foo___bar->B', 'A->foo___bar']);
  });

  it('keeps the text of a labelled link and the graph around it', async () => {
    const diagram = ['flowchart LR', '    cache.ts -- ref.invalidate --> store.ts'].join('\n');

    const graph = await parseFlowchart(sanitizeMermaidDiagram(diagram));

    expect(graph.nodes).toEqual(['cache_ts', 'store_ts']);
    expect(graph.edges).toEqual(['cache_ts->store_ts']);
  });

  it('does not read pipes inside a node label as an edge label', async () => {
    const diagram = 'flowchart LR\nA["a|doc()|b"] --> B';
    const sanitized = sanitizeMermaidDiagram(diagram);
    expect(sanitized).toBe(diagram);
    expect(await parseFlowchart(sanitized)).toEqual(await parseFlowchart(diagram));
  });

  it('repairs an edge label even when the preceding node label contains a pipe', async () => {
    const sanitized = sanitizeMermaidDiagram('flowchart LR\nA["a | b"] -->|doc()| B');
    expect(sanitized).toBe('flowchart LR\nA["a | b"] -->|"doc()"| B');
    expect((await parseFlowchart(sanitized)).edges).toEqual(['A->B']);
  });

  it.each([
    'A & file.ts --> B\nfile.ts --> C',
    'file.ts & A --> B\nfile.ts --> C',
    'A --> B & file.ts\nfile.ts --> C',
    'A --> file.ts; file.ts --> C',
  ])('preserves shared node identities in fan-out and statements: %s', async (body) => {
    const original = await parseFlowchart('flowchart LR\n' + body);
    const sanitized = sanitizeMermaidDiagram('flowchart LR\n' + body);
    const graph = await parseFlowchart(sanitized);
    expect(graph.nodes).toEqual(original.nodes.map((id) => id.replaceAll('.', '_')));
    expect(graph.edges).toEqual(original.edges.map((edge) => edge.replaceAll('.', '_')));
    expect(sanitizeMermaidDiagram(sanitized)).toBe(sanitized);
  });

  it.each(['A --> file.ts\nfile_ts --> B', 'file_ts --> B\nA --> file.ts'])(
    'does not merge an alias with an existing node: %s',
    async (body) => {
      const graph = await parseFlowchart(sanitizeMermaidDiagram('flowchart LR\n' + body));
      expect(graph.nodes).toHaveLength(4);
      expect(graph.edges).toContain('file_ts->B');
      expect(graph.edges).toContain('A->file_ts_2');
    },
  );

  it.each([
    '["value.when(...) | call() | a & b; c --> d"]',
    '("value.when(...) | call() | a & b; c --> d")',
    '(["value.when(...) | call() | a & b; c --> d"])',
    '[["value.when(...) | call() | a & b; c --> d"]]',
    '[("value.when(...) | call() | a & b; c --> d")]',
    '(("value.when(...) | call() | a & b; c --> d"))',
    '>"value.when(...) | call() | a & b; c --> d"]',
    '{"value.when(...) | call() | a & b; c --> d"}',
    '{{"value.when(...) | call() | a & b; c --> d"}}',
    '[/"value.when(...) | call() | a & b; c --> d"/]',
    '((("value.when(...) | call() | a & b; c --> d")))',
  ])('preserves node shape and label contents: %s', async (shape) => {
    const diagram = `flowchart LR\nA${shape} --> B${shape}`;
    const original = await parseFlowchart(diagram);
    const sanitized = sanitizeMermaidDiagram(diagram);
    expect(sanitized).toBe(diagram);
    expect(await parseFlowchart(sanitized)).toEqual(original);
  });

  it.each([
    '-->',
    '---',
    '<-->',
    '==>',
    '===',
    '-.->',
    '-..-',
    '--x',
    '--o',
    'x--x',
    'o--o',
    '-- text -->',
    '== text ==>',
    '-. text .->',
    '-->|"doc()"|',
  ])('preserves link style and text: %s', async (link) => {
    const diagram = `flowchart LR\nA ${link} B`;
    expect(await parseFlowchart(sanitizeMermaidDiagram(diagram))).toEqual(
      await parseFlowchart(diagram),
    );
  });

  it('leaves sequence diagram syntax to its own parser', async () => {
    const diagram = 'sequenceDiagram\nclient.ts-->>server.ts: done';
    await expect(mermaid.mermaidAPI.getDiagramFromText(diagram)).resolves.toBeTruthy();
    expect(sanitizeMermaidDiagram(diagram)).toBe(diagram);
  });

  it('quotes edge labels using Mermaid entities rather than JavaScript escapes', async () => {
    const sanitized = sanitizeMermaidDiagram('flowchart LR\nA -->|doc("C:\\tmp")| B');
    expect(sanitized).toBe('flowchart LR\nA -->|"doc(#quot;C:\\tmp#quot;)"| B');
    expect((await parseFlowchart(sanitized)).edges).toEqual(['A->B']);
  });

  it('keeps an asymmetric shape and its link-like label text', async () => {
    const diagram = 'flowchart LR\nfile.ts>value --> other.ts & x] --> B';
    const graph = await parseFlowchart(sanitizeMermaidDiagram(diagram));
    expect(graph.nodes).toEqual(['file_ts', 'B']);
    expect(graph.edges).toEqual(['file_ts->B']);
    expect(graph.labels).toEqual((await parseFlowchart(diagram)).labels);
  });

  it.each(['file.ts["File"]\nA --> file.ts', 'A --> file.ts\nfile.ts["File"]'])(
    'preserves an explicit label across bare references: %s',
    async (body) => {
      const original = await parseFlowchart('flowchart LR\n' + body);
      const graph = await parseFlowchart(sanitizeMermaidDiagram('flowchart LR\n' + body));
      expect(graph.labels).toEqual(original.labels);
    },
  );

  it('keeps style and class references attached to the aliased node', async () => {
    const diagram = 'flowchart LR\nA --> file.ts\nstyle file.ts fill:red\nclass file.ts active';
    const sanitized = sanitizeMermaidDiagram(diagram);
    const parsed = await mermaid.mermaidAPI.getDiagramFromText(sanitized);
    const vertices = (
      parsed.db as { getVertices(): Map<string, { styles: string[]; classes: string[] }> }
    ).getVertices();
    expect([...vertices.keys()]).toEqual(['A', 'file_ts']);
    expect(vertices.get('file_ts')?.styles).toContain('fill:red');
    expect(vertices.get('file_ts')?.classes).toContain('active');
  });

  it('reserves subgraph identifiers before allocating node aliases', async () => {
    const diagram = 'flowchart LR\nsubgraph file_ts\nA --> file.ts\nend';
    expect((await parseFlowchart(sanitizeMermaidDiagram(diagram))).edges).toEqual(['A->file_ts_2']);
  });

  it.each([
    ['style.css', 'style_css'],
    ['direction.ts', 'direction_ts'],
    ['click-handler.ts', 'node_click-handler_ts'],
    ['class-loader.ts', 'node_class-loader_ts'],
  ])('does not mistake the filename %s for a directive', async (id, alias) => {
    const sanitized = sanitizeMermaidDiagram(`flowchart LR\n${id} --> B\nA --> ${id}`);
    expect((await parseFlowchart(sanitized)).edges).toEqual([`${alias}->B`, `A->${alias}`]);
    expect(sanitizeMermaidDiagram(sanitized)).toBe(sanitized);
  });

  it('preserves frontmatter while repairing the diagram below it', async () => {
    const frontmatter =
      '---\ntitle: "file.ts --> doc()"\nconfig:\n  flowchart:\n    curve: linear\n---\n';
    const sanitized = sanitizeMermaidDiagram(
      frontmatter + '%% flow\nflowchart LR\ndoc() -->|doc()| B',
    );
    expect(sanitized.startsWith(frontmatter)).toBe(true);
    expect((await parseFlowchart(sanitized)).edges).toEqual(['doc->B']);
    expect(sanitizeMermaidDiagram(sanitized)).toBe(sanitized);
  });

  it('preserves multiline initialization directives', async () => {
    const prelude = '%%{init: {\n  "theme": "dark"\n}}%%\n';
    const sanitized = sanitizeMermaidDiagram(prelude + 'flowchart LR\ndoc() --> B');
    expect(sanitized.startsWith(prelude)).toBe(true);
    expect((await parseFlowchart(sanitized)).edges).toEqual(['doc->B']);
  });

  it('aliases nodes following a header on the same line', async () => {
    const sanitized = sanitizeMermaidDiagram('flowchart LR; A --> file.ts\nfile.ts --> B');
    expect((await parseFlowchart(sanitized)).edges).toEqual(['A->file_ts', 'file_ts->B']);
  });

  it.each(['-->|returns List<File>|', '-- returns Map<K,V> -->'])(
    'keeps generic types in link text separate from the target: %s',
    async (link) => {
      const diagram = `flowchart LR\nA ${link} loader.ts[Loader]\nloader.ts --> C`;
      const sanitized = sanitizeMermaidDiagram(diagram);
      const graph = await parseFlowchart(sanitized);
      expect(graph.nodes).toEqual(['A', 'loader_ts', 'C']);
      expect(graph.edges).toEqual(['A->loader_ts', 'loader_ts->C']);
      expect(graph.labels).toEqual((await parseFlowchart(diagram)).labels);
      expect(sanitizeMermaidDiagram(sanitized)).toBe(sanitized);
    },
  );

  it.each(['shape: rect', 'shape: rect, label: "File"', 'label: "File", shape: rect'])(
    'preserves the label of a node with metadata: %s',
    async (metadata) => {
      const diagram = `flowchart LR\nfile.ts@{ ${metadata} }\nfile.ts --> B`;
      const graph = await parseFlowchart(sanitizeMermaidDiagram(diagram));
      expect(graph.nodes).toEqual(['file_ts', 'B']);
      expect(graph.labels).toEqual((await parseFlowchart(diagram)).labels);
    },
  );

  it('preserves multiline quoted labels containing diagram syntax', async () => {
    const diagram = 'flowchart LR\nA["first\nfile.ts --> done & x; y"] --> file.ts\nfile.ts --> B';
    const sanitized = sanitizeMermaidDiagram(diagram);
    const graph = await parseFlowchart(sanitized);
    expect(graph.nodes).toEqual(['A', 'file_ts', 'B']);
    const original = await parseFlowchart(diagram);
    expect(graph.labels.map(({ text }) => text)).toEqual(original.labels.map(({ text }) => text));
    expect(graph.labels[0]).toEqual(original.labels[0]);
    expect(sanitizeMermaidDiagram(sanitized)).toBe(sanitized);
  });

  it.each(['A:::hot --> B', 'A --> file.ts:::hot\nfile.ts --> B'])(
    'preserves class shorthand: %s',
    async (body) => {
      const parsed = await mermaid.mermaidAPI.getDiagramFromText(
        sanitizeMermaidDiagram('flowchart LR\n' + body),
      );
      const vertices = (
        parsed.db as { getVertices(): Map<string, { classes: string[] }> }
      ).getVertices();
      const id = body.startsWith('A:::') ? 'A' : 'file_ts';
      expect(vertices.get(id)?.classes).toContain('hot');
      expect(vertices.size).toBe(body.startsWith('A:::') ? 2 : 3);
    },
  );
});
