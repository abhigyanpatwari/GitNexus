import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { processesPhase } from '../../src/core/ingestion/pipeline-phases/processes.js';
import { toolsPhase } from '../../src/core/ingestion/pipeline-phases/tools.js';
import type {
  PhaseResult,
  PipelineContext,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import type { GraphNode, GraphRelationship, NodeLabel } from 'gitnexus-shared';

function makeCtx(graph: KnowledgeGraph, repoPath = 'D:/tmp/repo'): PipelineContext {
  return {
    repoPath,
    graph,
    onProgress: () => {},
    pipelineStart: 0,
  };
}

function phaseResult<T>(phaseName: string, output: T): PhaseResult<T> {
  return { phaseName, output, durationMs: 0 };
}

function addNode(
  graph: KnowledgeGraph,
  id: string,
  label: NodeLabel,
  name: string,
  filePath: string,
) {
  graph.addNode({
    id,
    label,
    properties: {
      name,
      filePath,
      startLine: 1,
      endLine: 1,
      isExported: true,
      content: '',
    },
  } satisfies GraphNode);
}

function addCall(graph: KnowledgeGraph, sourceId: string, targetId: string) {
  graph.addRelationship({
    id: `${sourceId}->${targetId}`,
    sourceId,
    targetId,
    type: 'CALLS',
    confidence: 1,
    reason: 'direct',
  } satisfies GraphRelationship);
}

describe('Tool handler and process linking phases', () => {
  it('falls back to the file node when a parsed tool handler is missing from the graph', async () => {
    const graph = createKnowledgeGraph();
    addNode(graph, 'File:src/tools.py', 'File', 'tools.py', 'src/tools.py');

    const output = await toolsPhase.execute(
      makeCtx(graph),
      new Map([
        [
          'parse',
          phaseResult('parse', {
            allToolDefs: [
              {
                filePath: 'src/tools.py',
                toolName: 'stale_tool',
                description: 'Stale handler',
                lineNumber: 1,
                handlerNodeId: 'Function:src/tools.py:missing',
              },
            ],
            allPaths: [],
          }),
        ],
      ]),
    );

    expect(output.toolDefs).toEqual([
      { name: 'stale_tool', filePath: 'src/tools.py', description: 'Stale handler' },
    ]);

    const edge = graph.relationships.find((rel) => rel.type === 'HANDLES_TOOL');
    expect(edge).toMatchObject({
      sourceId: 'File:src/tools.py',
      targetId: 'Tool:stale_tool',
    });
  });

  it('does not attach file-level fallback tools to handler-specific processes', async () => {
    const graph = createKnowledgeGraph();
    const filePath = 'src/tools.ts';
    const alpha = 'Function:src/tools.ts:alpha';
    const alphaHelper = 'Function:src/tools.ts:alphaHelper';
    const alphaLeaf = 'Function:src/tools.ts:alphaLeaf';
    const fileEntry = 'Function:src/tools.ts:fileEntry';
    const fileHelper = 'Function:src/tools.ts:fileHelper';
    const fileLeaf = 'Function:src/tools.ts:fileLeaf';

    addNode(graph, 'File:src/tools.ts', 'File', 'tools.ts', filePath);
    addNode(graph, alpha, 'Function', 'alpha', filePath);
    addNode(graph, alphaHelper, 'Function', 'alphaHelper', filePath);
    addNode(graph, alphaLeaf, 'Function', 'alphaLeaf', filePath);
    addNode(graph, fileEntry, 'Function', 'fileEntry', filePath);
    addNode(graph, fileHelper, 'Function', 'fileHelper', filePath);
    addNode(graph, fileLeaf, 'Function', 'fileLeaf', filePath);
    addNode(graph, 'Tool:alpha', 'Tool', 'alpha', filePath);
    addNode(graph, 'Tool:fallback_tool', 'Tool', 'fallback_tool', filePath);
    addCall(graph, alpha, alphaHelper);
    addCall(graph, alphaHelper, alphaLeaf);
    addCall(graph, fileEntry, fileHelper);
    addCall(graph, fileHelper, fileLeaf);

    await processesPhase.execute(
      makeCtx(graph),
      new Map([
        ['structure', phaseResult('structure', { totalFiles: 1 })],
        ['communities', phaseResult('communities', { communityResult: { memberships: [] } })],
        ['routes', phaseResult('routes', { routeRegistry: new Map() })],
        [
          'tools',
          phaseResult('tools', {
            toolDefs: [
              { name: 'alpha', filePath, description: '', handlerNodeId: alpha },
              { name: 'fallback_tool', filePath, description: '' },
            ],
          }),
        ],
      ]),
    );

    const processEntryById = new Map(
      graph.nodes
        .filter((node) => node.label === 'Process')
        .map((node) => [node.id, node.properties.entryPointId]),
    );
    const linkedEntriesByTool = new Map<string, unknown[]>();
    for (const rel of graph.relationships.filter((edge) => edge.type === 'ENTRY_POINT_OF')) {
      const list = linkedEntriesByTool.get(rel.sourceId) ?? [];
      list.push(processEntryById.get(rel.targetId));
      linkedEntriesByTool.set(rel.sourceId, list);
    }

    expect(linkedEntriesByTool.get('Tool:alpha')).toEqual([alpha]);
    expect(linkedEntriesByTool.get('Tool:fallback_tool')).toEqual([fileEntry]);
  });
});
