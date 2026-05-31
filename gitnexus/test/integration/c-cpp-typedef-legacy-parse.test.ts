import { describe, expect, it } from 'vitest';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processParsing } from '../../src/core/ingestion/parsing-processor.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

const parseNodes = async (path: string, content: string) => {
  const graph = createKnowledgeGraph();
  const model = createSemanticModel();
  await processParsing(
    graph,
    [{ path, content }],
    model.symbols,
    createASTCache(),
    createASTCache(),
  );
  return graph.nodes;
};

describe('C/C++ legacy parse typedef captures', () => {
  it('emits one concrete C symbol for anonymous typedef structs and enums', async () => {
    const nodes = await parseNodes(
      'include/types.c',
      'typedef struct { int x; int y; } Point;\ntypedef enum { RED, GREEN } Color;\n',
    );

    expect(
      nodes.filter((node) => node.label === 'Struct' && node.id.endsWith(':Point')),
    ).toHaveLength(1);
    expect(
      nodes.filter((node) => node.label === 'Enum' && node.id.endsWith(':Color')),
    ).toHaveLength(1);
    expect(
      nodes.filter((node) => node.label === 'Typedef' && node.id.endsWith(':Point')),
    ).toHaveLength(0);
    expect(
      nodes.filter((node) => node.label === 'Typedef' && node.id.endsWith(':Color')),
    ).toHaveLength(0);
  });

  it('emits one concrete C++ symbol for anonymous typedef structs and enums', async () => {
    const nodes = await parseNodes(
      'include/types.cpp',
      'typedef struct { int x; int y; } Point;\ntypedef enum { Red, Green } Color;\n',
    );

    expect(
      nodes.filter((node) => node.label === 'Struct' && node.id.endsWith(':Point')),
    ).toHaveLength(1);
    expect(
      nodes.filter((node) => node.label === 'Enum' && node.id.endsWith(':Color')),
    ).toHaveLength(1);
    expect(
      nodes.filter((node) => node.label === 'Typedef' && node.id.endsWith(':Point')),
    ).toHaveLength(0);
    expect(
      nodes.filter((node) => node.label === 'Typedef' && node.id.endsWith(':Color')),
    ).toHaveLength(0);
  });
});
