import { describe, expect, it, vi } from 'vitest';
import { createGraphRAGTools, type GraphRAGBackend } from '../../src/core/llm/tools';

const noOpBackend: GraphRAGBackend = {
  executeQuery: async () => [],
  search: async () => [],
  grep: async () => ({ results: [] }),
  readFile: async () => '',
};

function grepTool(backend: GraphRAGBackend) {
  return createGraphRAGTools(backend).find((candidate) => candidate.name === 'grep')!;
}

describe('grep tool timeout contract', () => {
  it('says the scan was incomplete when the server sets timedOut with no hits', async () => {
    const grep = vi.fn(async () => ({ results: [] as const, timedOut: true as const }));
    const output = await grepTool({ ...noOpBackend, grep }).invoke({ pattern: 'signOrder' });
    expect(output).toContain('No matches for "signOrder"');
    expect(output).toContain('results may be incomplete');
  });

  it('still warns when a timed-out scan returned some hits below the limit', async () => {
    const grep = vi.fn(async () => ({
      results: [{ filePath: 'a.ts', line: 1, text: 'signOrder()' }],
      timedOut: true as const,
    }));
    const output = await grepTool({ ...noOpBackend, grep }).invoke({
      pattern: 'signOrder',
      maxResults: 100,
    });
    expect(output).toContain('Found 1 matches');
    expect(output).toContain('results may be incomplete');
    expect(output).not.toContain('Showing first');
  });
});
