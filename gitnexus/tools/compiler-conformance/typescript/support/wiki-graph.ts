import { after, mock } from 'node:test';

type WikiQueries = typeof import('../../../../src/core/wiki/graph-queries.js');

export function mockWikiGraph(overrides: Partial<WikiQueries>) {
  const queries = mock.module(
    new URL('../../../../dist/core/wiki/graph-queries.js', import.meta.url).href,
    {
      namedExports: {
        initWikiDb: async () => {},
        closeWikiDb: async () => {},
        touchWikiDb() {},
        pinWikiDb: () => () => {},
        getFilesWithExports: async () => [],
        getAllFiles: async () => [],
        getInterFileCallEdges: async () => [],
        getIntraModuleCallEdges: async () => [],
        getInterModuleCallEdges: async () => ({ incoming: [], outgoing: [] }),
        getProcessesForFiles: async () => [],
        getAllProcesses: async () => [],
        getInterModuleEdgesForOverview: async () => [],
        ...overrides,
      },
    },
  );
  after(() => queries.restore());
}

export function streamedWikiResponse(content: string, finishReason = 'stop'): Response {
  const chunk = { choices: [{ delta: { content }, finish_reason: finishReason }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
