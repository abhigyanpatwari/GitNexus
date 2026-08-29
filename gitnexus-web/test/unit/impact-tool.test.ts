import { describe, expect, it, vi } from 'vitest';
import { createGraphRAGTools, type GraphRAGBackend } from '../../src/core/llm/tools';

const noOpBackend: GraphRAGBackend = {
  executeQuery: async () => [],
  search: async () => [],
  grep: async () => [],
  readFile: async () => '',
};

function impactTool(backend: GraphRAGBackend) {
  return createGraphRAGTools(backend).find((candidate) => candidate.name === 'impact')!;
}

describe('Graph-RAG impact risk contract', () => {
  it('advertises the edit gate, shared axes, and MCP File difference', () => {
    const description = impactTool(noOpBackend).description;
    expect(description).toContain('RISK is the edit gate');
    expect(description).toContain('Shared-axes risk');
    expect(description).toContain('riskScale');
    expect(description).toContain('MCP File impact does not');
  });

  it('renders failed enrichment as unavailable and fails the risk gate closed', async () => {
    const executeQuery = vi.fn(async (query: string) => {
      if (query.includes("WHERE n.name = 'target'")) {
        return [{ id: 'target-id', nodeType: 'Function', filePath: 'src/target.ts' }];
      }
      if (query.includes('MATCH (affected)-[r:CodeRelation]->(target)')) {
        return [
          {
            id: 'caller-id',
            name: 'caller',
            nodeType: 'Function',
            filePath: 'src/caller.ts',
            startLine: 4,
            edgeType: 'CALLS',
            confidence: 1,
          },
        ];
      }
      if (query.includes('STEP_IN_PROCESS')) throw new Error('process query failed');
      if (query.includes('MEMBER_OF')) return [];
      return [];
    });

    const output = await impactTool({ ...noOpBackend, executeQuery }).invoke({
      target: 'target',
      direction: 'upstream',
      maxDepth: 1,
    });

    expect(output).toContain('AFFECTED PROCESSES:\n- Unavailable (enrichment query failed)');
    expect(output).not.toContain('AFFECTED PROCESSES:\n- None found');
    expect(output).toContain('RISK: UNKNOWN');
    expect(output).toContain('risk is unresolved because enrichment failed');
    expect(output).toContain('- Processes affected: unavailable');
  });

  it('preserves proved CRITICAL risk when the cluster query fails', async () => {
    const executeQuery = vi.fn(async (query: string) => {
      if (query.includes("WHERE n.name = 'target'")) {
        return [{ id: 'target-id', nodeType: 'Function', filePath: 'src/target.ts' }];
      }
      if (query.includes('MATCH (affected)-[r:CodeRelation]->(target)')) {
        return [
          {
            id: 'caller-id',
            name: 'caller',
            nodeType: 'Function',
            filePath: 'src/caller.ts',
            edgeType: 'CALLS',
            confidence: 1,
          },
        ];
      }
      if (query.includes('STEP_IN_PROCESS')) {
        return Array.from({ length: 5 }, (_, index) => ({
          label: `process-${index}`,
          hits: 1,
          minStep: index + 1,
          stepCount: 5,
        }));
      }
      if (query.includes('MEMBER_OF') && query.includes('COUNT(DISTINCT s.id)')) {
        throw new Error('cluster query failed');
      }
      if (query.includes('MEMBER_OF')) return [];
      return [];
    });

    const output = await impactTool({ ...noOpBackend, executeQuery }).invoke({
      target: 'target',
      direction: 'upstream',
      maxDepth: 1,
    });

    expect(output).toContain('RISK: CRITICAL');
    expect(output).toContain('AFFECTED CLUSTERS:\n- Unavailable (enrichment query failed)');
    expect(output).toContain('- Processes affected: 5');
    expect(output).toContain('- Clusters affected: unavailable');
  });

  it('does not invent direct/indirect cluster classification after its query fails', async () => {
    const executeQuery = vi.fn(async (query: string) => {
      if (query.includes("WHERE n.name = 'target'")) {
        return [{ id: 'target-id', nodeType: 'Function', filePath: 'src/target.ts' }];
      }
      if (query.includes('MATCH (affected)-[r:CodeRelation]->(target)')) {
        return [
          {
            id: 'caller-id',
            name: 'caller',
            nodeType: 'Function',
            filePath: 'src/caller.ts',
            edgeType: 'CALLS',
            confidence: 1,
          },
        ];
      }
      if (query.includes('STEP_IN_PROCESS')) return [];
      if (query.includes('MEMBER_OF') && query.includes('RETURN DISTINCT')) {
        throw new Error('classification query failed');
      }
      if (query.includes('MEMBER_OF')) return [{ label: 'Core', hits: 1 }];
      return [];
    });

    const output = await impactTool({ ...noOpBackend, executeQuery }).invoke({
      target: 'target',
      direction: 'upstream',
      maxDepth: 1,
    });

    expect(output).toContain('- Core (classification-unavailable, 1 symbols)');
    expect(output).toContain('direct/indirect cluster classification is unavailable');
    expect(output).not.toContain('process/module axes were unused');
  });

  it('treats successful File expansion as comparable because enrichment runs on member symbols', async () => {
    const executeQuery = vi.fn(async (query: string) => {
      if (query.includes("n.filePath CONTAINS 'src/target.ts'")) {
        return [{ id: 'file-id', nodeType: 'File', filePath: 'src/target.ts' }];
      }
      if (query.includes("callee.filePath = 'src/target.ts'")) {
        return [
          {
            id: 'caller-id',
            name: 'caller',
            nodeType: 'Function',
            filePath: 'src/caller.ts',
            edgeType: 'CALLS',
            confidence: 1,
          },
        ];
      }
      if (query.includes('STEP_IN_PROCESS')) {
        return [{ label: 'Build', hits: 1, minStep: 1, stepCount: 1 }];
      }
      if (query.includes('MEMBER_OF') && query.includes('RETURN DISTINCT')) {
        return [{ label: 'Core' }];
      }
      if (query.includes('MEMBER_OF')) return [{ label: 'Core', hits: 1 }];
      return [];
    });

    const output = await impactTool({ ...noOpBackend, executeQuery }).invoke({
      target: 'src/target.ts',
      direction: 'upstream',
      maxDepth: 1,
    });

    expect(output).toContain('process/cluster axes are comparable here when enrichment succeeds');
    expect(output).toContain('- Processes affected: 1');
    expect(output).toContain('- Clusters affected: 1');
    expect(output).not.toContain('process/module axes were unused');
  });

  it('surfaces the 500-symbol enrichment cap as partial', async () => {
    const executeQuery = vi.fn(async (query: string) => {
      if (query.includes("WHERE n.name = 'target'")) {
        return [{ id: 'target-id', nodeType: 'Function', filePath: 'src/target.ts' }];
      }
      const depth = query.includes('3 AS depth') ? 3 : query.includes('2 AS depth') ? 2 : 1;
      if (query.includes('CodeRelation') && query.includes(` ${depth} AS depth`)) {
        return Array.from({ length: 200 }, (_, index) => ({
          id: `d${depth}-${index}`,
          name: `node-${depth}-${index}`,
          nodeType: 'Function',
          filePath: `src/d${depth}-${index}.ts`,
          edgeType: 'CALLS',
          confidence: 1,
        }));
      }
      if (query.includes('STEP_IN_PROCESS') || query.includes('MEMBER_OF')) return [];
      return [];
    });

    const output = await impactTool({ ...noOpBackend, executeQuery }).invoke({
      target: 'target',
      direction: 'upstream',
      maxDepth: 3,
    });

    expect(output).toContain('process/cluster enrichment is partial (first 500 symbols)');
    expect(output).toContain('enrichment-truncated');
    expect(output).not.toContain('enrichment-budget-exhausted');
  });
});
