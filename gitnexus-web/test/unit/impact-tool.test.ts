import { describe, expect, it, vi } from 'vitest';
import { createGraphRAGTools, type GraphRAGBackend } from '../../src/core/llm/tools';

const noOpBackend: GraphRAGBackend = {
  executeQuery: async () => [],
  search: async () => ({ results: [] }),
  grep: async () => ({ results: [], timedOut: false }),
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

  it.each(['upstream', 'downstream'] as const)(
    'reports omitted name-only calls and never expands them on a %s walk',
    async (direction) => {
      const executeQuery = vi.fn(async (query: string) =>
        query.includes("WHERE n.name = 'target'")
          ? [{ id: 'target-id', nodeType: 'Function', filePath: 'target.ts' }]
          : query.includes('1 AS depth')
            ? [
                {
                  id: 'candidate',
                  filePath: 'caller.c',
                  edgeType: 'CALLS',
                  reason: 'global-name-fallback',
                },
              ]
            : [],
      );
      const output = await impactTool({ ...noOpBackend, executeQuery }).invoke({
        target: 'target',
        direction,
        maxDepth: 3,
      });
      for (const [depth, aliases] of [
        [2, ['r1']],
        [3, ['r1', 'r2']],
      ] as const) {
        const query = executeQuery.mock.calls
          .map(([sql]) => sql)
          .find((sql) => sql.includes(depth + ' AS depth'));
        for (const alias of aliases)
          expect(query).toContain(alias + ".reason <> 'global-name-fallback'");
      }
      expect(output).toContain('RISK: UNKNOWN');
      expect(output).toContain('Calls omitted because only the name matched: 1');
    },
  );

  it('withholds a low verdict when direct callers are unavailable but depth two succeeds', async () => {
    const executeQuery = vi.fn(async (query: string) => {
      if (query.includes("WHERE n.name = 'target'"))
        return [{ id: 'target-id', nodeType: 'Function', filePath: 'target.ts' }];
      if (query.includes('1 AS depth')) throw new Error('depth one failed');
      if (query.includes('2 AS depth'))
        return [{ id: 'indirect', name: 'indirect', nodeType: 'Function', filePath: 'two.ts' }];
      return [];
    });
    const output = await impactTool({ ...noOpBackend, executeQuery }).invoke({
      target: 'target',
      direction: 'upstream',
      maxDepth: 2,
    });
    expect(output).toContain('indirect');
    expect(output).toContain('RISK: UNKNOWN');
    expect(output).toContain('Shared-axes: UNKNOWN');
    expect(output).toContain('Failed depth queries: 1');
    expect(output).toContain('Direct callers: unavailable');
  });

  it.each([
    [2, 200, 200],
    [2, 200, 201],
    [3, 100, 100],
    [3, 100, 101],
  ])('checks d=%i with a %i-row budget and %i available rows', async (depth, limit, rows) => {
    const executeQuery = vi.fn(async (query: string) => {
      if (query.includes("WHERE n.name = 'target'"))
        return [{ id: 'target-id', nodeType: 'Function', filePath: 'src/target.ts' }];
      if (query.includes('1 AS depth')) return [{ id: 'direct', filePath: 'src/one.ts' }];
      if (query.includes(depth + ' AS depth')) {
        return Array.from({ length: rows }, (_, i) => ({
          id: 'leaf-' + i,
          filePath: 'src/leaf.ts',
        }));
      }
      return [];
    });
    const output = await impactTool({ ...noOpBackend, executeQuery }).invoke({
      target: 'target',
      direction: 'upstream',
      maxDepth: depth,
    });
    expect(executeQuery).toHaveBeenCalledWith(expect.stringContaining('LIMIT ' + (limit + 1)));
    expect(output).toContain(limit + 1 + ' affected');
    if (rows === limit) {
      expect(output).toContain('RISK: LOW');
      expect(output).not.toContain('Incomplete traversal');
      expect(output).toContain('GRAPH ANALYSIS COMPLETE');
    } else {
      expect(output).toContain('RISK: UNKNOWN');
      expect(output).toContain('Row limit exceeded at d=' + depth);
      expect(output).not.toContain('GRAPH ANALYSIS COMPLETE');
    }
  });

  it('reports an incomplete walk when every retained row is filtered out', async () => {
    const executeQuery = vi.fn(async (query: string) => {
      if (query.includes("WHERE n.name = 'target'"))
        return [{ id: 'target-id', nodeType: 'Function', filePath: 'src/target.ts' }];
      if (query.includes('1 AS depth'))
        return Array.from({ length: 301 }, (_, i) => ({
          id: 'node-' + i,
          filePath: i < 300 ? 'a.test.ts' : 'src/overflow.ts',
        }));
      return [];
    });
    const output = await impactTool({ ...noOpBackend, executeQuery }).invoke({
      target: 'target',
      direction: 'downstream',
      maxDepth: 1,
    });
    expect(output).toContain('RISK: UNKNOWN');
    expect(output).toContain('Row limit exceeded at d=1');
    expect(output).not.toContain('self-contained');
    expect(executeQuery).toHaveBeenCalledWith(expect.stringContaining('LIMIT 301'));
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
    expect(output).not.toContain('GRAPH ANALYSIS COMPLETE');
    expect(output).toContain('- Processes affected: unavailable');
  });

  it('preserves proved CRITICAL risk from direct callers when the cluster query fails', async () => {
    const executeQuery = vi.fn(async (query: string) => {
      if (query.includes("WHERE n.name = 'target'")) {
        return [{ id: 'target-id', nodeType: 'Function', filePath: 'src/target.ts' }];
      }
      if (query.includes('MATCH (affected)-[r:CodeRelation]->(target)')) {
        return Array.from({ length: 301 }, (_, i) => ({
          id: 'caller-' + i,
          name: 'caller' + i,
          nodeType: 'Function',
          filePath: 'src/caller.ts',
          edgeType: 'CALLS',
          confidence: 1,
        }));
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
    expect(output).toContain('Shared-axes: CRITICAL');
    expect(output).toContain('Direct callers: at least 300');
    expect(output).toContain('Row limit exceeded at d=1');
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
    expect(output).not.toContain('GRAPH ANALYSIS COMPLETE');
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
        return Array.from({ length: [300, 200, 1][depth - 1] }, (_, index) => ({
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
    expect(output).not.toContain('GRAPH ANALYSIS COMPLETE');
    expect(output).toContain('enrichment-truncated');
    expect(output).not.toContain('enrichment-budget-exhausted');
  });

  it('does not treat a filename substring as a unique File suffix', async () => {
    const executeQuery = vi.fn(async (query: string) => {
      if (query.includes('filePath CONTAINS')) {
        return [
          { id: 'file-mylib', nodeType: 'File', filePath: 'src/mylib/foo.ts' },
          { id: 'fn-mylib', nodeType: 'Function', filePath: 'src/mylib/foo.ts' },
        ];
      }
      return [];
    });

    const output = await impactTool({ ...noOpBackend, executeQuery }).invoke({
      target: 'lib/foo.ts',
      direction: 'upstream',
      maxDepth: 1,
    });

    expect(output).toContain('AMBIGUOUS TARGET');
    expect(output).toContain('lib/foo.ts');
  });

  it('does not accept a unique File suffix from a truncated CONTAINS page', async () => {
    const executeQuery = vi.fn(async (query: string) => {
      if (query.includes('filePath CONTAINS')) {
        return [
          ...Array.from({ length: 9 }, (_, index) => ({
            id: `sym-${index}`,
            nodeType: 'Function',
            filePath: `src/other-${index}.ts`,
          })),
          { id: 'file-visible', nodeType: 'File', filePath: 'apps/web/lib/foo.ts' },
        ];
      }
      return [];
    });

    const output = await impactTool({ ...noOpBackend, executeQuery }).invoke({
      target: 'lib/foo.ts',
      direction: 'upstream',
      maxDepth: 1,
    });

    expect(output).toContain('AMBIGUOUS TARGET');
    expect(output).toContain('Could not uniquely match');
  });
});
