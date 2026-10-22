import { describe, expect, it, vi } from 'vitest';
import { createGraphRAGTools, type GraphRAGBackend } from '../../src/core/llm/tools';

const noOpBackend: GraphRAGBackend = {
  executeQuery: async () => [],
  search: async () => [],
  grep: async () => ({ results: [], timedOut: false }),
  readFile: async () => '',
};

const invalidQuery =
  "MATCH (f:File)-[:CodeRelation {type: 'DEFINES'}]->(n) " +
  "WHERE f.name IN ['main.py', 'parser.py'] AND (n:Function OR n:Method OR n:Class) " +
  'RETURN f.name AS file, labels(n)[0] AS kind, n.name AS name';
const correctedQuery =
  "MATCH (f:File)-[:CodeRelation {type: 'DEFINES'}]->(n) " +
  "WHERE f.name IN ['main.py', 'parser.py'] AND label(n) IN ['Function', 'Method', 'Class'] " +
  'RETURN f.name AS file, label(n) AS kind, n.name AS name';

function cypherTool(backend: GraphRAGBackend) {
  const tool = createGraphRAGTools(backend).find((candidate) => candidate.name === 'cypher');
  if (!tool) throw new Error('Cypher tool is not registered');
  return tool;
}

describe('Cypher dialect recovery', () => {
  it('teaches mixed-type label filtering before the first query', () => {
    const tool = cypherTool(noOpBackend);
    expect(tool.description).toContain('LadybugDB');
    expect(tool.description).toContain("label(n) IN ['Function', 'Method', 'Class']");
    expect(tool.description).toContain('labels(n)[0]');
  });

  it('keeps the native failure and gives syntax that can be retried without rewriting queries', async () => {
    const nativeError = 'Prepare failed: Parser exception: Invalid input <WHERE n:>';
    const executeQuery = vi
      .fn<GraphRAGBackend['executeQuery']>()
      .mockRejectedValueOnce(new Error(nativeError))
      .mockResolvedValueOnce([{ file: 'parser.py', kind: 'Function', name: 'parse' }]);
    const tool = cypherTool({ ...noOpBackend, executeQuery });

    const failure = await tool.invoke({ cypher: invalidQuery });
    expect(failure).toContain(nativeError);
    expect(failure).toContain("label(n) IN ['Function', 'Method', 'Class']");
    expect(failure).toContain('label(n) AS kind');
    expect(failure).toMatch(/retry/i);
    expect(executeQuery).toHaveBeenCalledExactlyOnceWith(invalidQuery);

    const recovered = await tool.invoke({ cypher: correctedQuery });
    expect(executeQuery).toHaveBeenLastCalledWith(correctedQuery);
    expect(executeQuery).toHaveBeenCalledTimes(2);
    expect(recovered).toContain('| parser.py | Function | parse |');
    expect(recovered).not.toContain('Cypher error:');
  });

  it('preserves other failures and successful empty results', async () => {
    const executeQuery = vi
      .fn<GraphRAGBackend['executeQuery']>()
      .mockRejectedValueOnce(new Error('Backend unavailable'))
      .mockResolvedValueOnce([]);
    const tool = cypherTool({ ...noOpBackend, executeQuery });
    expect(await tool.invoke({ cypher: correctedQuery })).toContain('Backend unavailable');
    expect(await tool.invoke({ cypher: correctedQuery })).toBe('Query returned no results.');
    expect(executeQuery).toHaveBeenCalledTimes(2);
  });
});
