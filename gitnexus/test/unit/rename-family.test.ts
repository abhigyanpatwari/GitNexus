import { describe, expect, it } from 'vitest';
import type { SymbolDefinition } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { graphRenameFamily } from '../../src/core/ingestion/languages/rename-family.js';
import type { RenameSemanticContext } from '../../src/core/ingestion/rename-provider.js';

function fixture(edge: boolean) {
  const graph = createKnowledgeGraph();
  const definitions: SymbolDefinition[] = [
    {
      nodeId: 'def:model.ts#1:0:Class:Base',
      filePath: 'model.ts',
      type: 'Class',
      qualifiedName: 'Base',
    },
    {
      nodeId: 'def:model.ts#4:0:Class:Derived',
      filePath: 'model.ts',
      type: 'Class',
      qualifiedName: 'Derived',
    },
  ];
  for (const [index, owner] of [...definitions].entries()) {
    graph.addNode({
      id: `Class:model.ts:${owner.qualifiedName}`,
      label: 'Class',
      properties: { name: owner.qualifiedName!, filePath: 'model.ts', startLine: index * 3 },
    });
    const method = {
      nodeId: `def:model.ts#${index * 3 + 2}:1:Method:close`,
      filePath: 'model.ts',
      type: 'Method' as const,
      qualifiedName: `${owner.qualifiedName}.close`,
      parameterCount: 0,
      ownerId: owner.nodeId,
    };
    definitions.push(method);
    graph.addNode({
      id: `Method:model.ts:${method.qualifiedName}#0`,
      label: 'Method',
      properties: {
        name: 'close',
        filePath: 'model.ts',
        startLine: index * 3 + 1,
        parameterCount: 0,
      },
    });
  }
  if (edge)
    graph.addRelationship({
      id: 'override',
      sourceId: 'Class:model.ts:Derived',
      targetId: 'Method:model.ts:Base.close#0',
      type: 'METHOD_OVERRIDES',
      confidence: 0.9,
      reason: 'single-ancestor override',
    });
  return {
    definitions,
    graph,
    target: definitions[2]!,
    indexes: {
      methodDispatch: {
        mroFor: (id: string) => (id === definitions[1]!.nodeId ? [definitions[0]!.nodeId] : []),
        implementorsOf: () => [],
      },
    },
  } as unknown as RenameSemanticContext;
}

describe('provider-selected graph rename families', () => {
  const matches = (left: SymbolDefinition, right: SymbolDefinition) =>
    left.type === 'Method' && right.type === 'Method';

  it('joins the precise class-to-method override edge to its written implementation', () => {
    const context = fixture(true);
    expect(graphRenameFamily(context, { matches })).toEqual([
      context.target,
      context.definitions[3],
    ]);
  });

  it('refuses a potential family when the graph has only owner inheritance', () => {
    expect(graphRenameFamily(fixture(false), { matches })).toMatchObject({
      code: 'unsupported_symbol_family',
    });
  });

  it('lets the provider reject incompatible syntax despite an override edge', () => {
    expect(graphRenameFamily(fixture(true), { matches, canCouple: () => false })).toMatchObject({
      code: 'unsupported_symbol_family',
    });
  });
});
