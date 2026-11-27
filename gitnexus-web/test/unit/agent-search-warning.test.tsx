import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetBreakerRegistry__ } from 'gitnexus-shared/test-helpers';
import { createGraphRAGAgent } from '../../src/core/llm/agent';
import { getActiveProviderConfig } from '../../src/core/llm/settings-service';
import { createGraphRAGTools } from '../../src/core/llm/tools';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';
import { search, setBackendUrl } from '../../src/services/backend-client';

vi.mock('../../src/core/llm/agent', () => ({
  createGraphRAGAgent: vi.fn(() => ({})),
}));

vi.mock('../../src/core/llm/context-builder', () => ({
  buildCodebaseContext: vi.fn(async () => ({})),
}));

vi.mock('../../src/core/llm/settings-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/llm/settings-service')>();
  return { ...actual, getActiveProviderConfig: vi.fn() };
});

const warning = 'FTS indexes missing — keyword search degraded. Run: gitnexus analyze --repair-fts';
const match = {
  nodeId: 'Function:src/auth.ts:authenticate',
  name: 'authenticate',
  label: 'Function',
  filePath: 'src/auth.ts',
  score: 0.8,
  sources: ['semantic'],
  processes: [{ id: 'login', label: 'Login', step: 1, stepCount: 2 }],
};

async function initializeTool(name: 'search' | 'cypher') {
  const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
  await act(async () => {
    await result.current.initializeAgent('app', { repo: '/work/app' });
  });
  expect(createGraphRAGAgent).toHaveBeenCalledOnce();
  const backend = vi.mocked(createGraphRAGAgent).mock.calls[0][1];
  const tool = createGraphRAGTools(backend).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool ${name} was not registered`);
  return tool;
}

describe('agent search diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBreakerRegistry__();
    setBackendUrl('http://search-client.test:4747');
    vi.mocked(getActiveProviderConfig).mockReturnValue({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { name: 'grouped matches', results: [match], groupByProcess: true, expected: 'PROCESS: Login' },
    { name: 'flat matches', results: [match], groupByProcess: false, expected: 'authenticate' },
    { name: 'no matches', results: [], groupByProcess: true, expected: 'No code found' },
  ])('retains the server warning for $name', async ({ results, groupByProcess, expected }) => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ results, warning }));
    vi.stubGlobal('fetch', fetchMock);
    const tool = await initializeTool('search');
    const output = await tool.invoke({ query: 'authentication', limit: 3, groupByProcess });

    expect(output.startsWith(`Search warning: ${warning}\nResults may be incomplete.\n\n`)).toBe(
      true,
    );
    expect(output.match(/Search warning:/g)).toHaveLength(1);
    expect(output).toContain(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://search-client.test:4747/api/search');
    expect(JSON.parse(init?.body as string)).toEqual({
      query: 'authentication',
      limit: 3,
      enrich: true,
      repo: '/work/app',
    });
  });

  it.each([
    {
      name: 'matches without a warning',
      response: { results: [match] },
      expected: 'Found 1 matches',
    },
    { name: 'no matches without a warning', response: { results: [] }, expected: 'No code found' },
    {
      name: 'a whitespace-only warning',
      response: { results: [match], warning: '   ' },
      expected: 'Found 1 matches',
    },
    {
      name: 'a non-string warning',
      response: { results: [match], warning: 42 },
      expected: 'Found 1 matches',
    },
  ])('does not display a warning for $name', async ({ response, expected }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(response)),
    );
    const tool = await initializeTool('search');
    const output = await tool.invoke({ query: 'authentication' });
    expect(output).toContain(expected);
    expect(output).not.toContain('Search warning:');
    expect(output).not.toContain('Results may be incomplete');
  });

  it.each([
    { name: 'matches', results: [match], expected: 'authenticate' },
    { name: 'no matches', results: [], expected: 'Semantic search returned no results' },
  ])('forwards a warning for semantic Cypher $name if provided', async ({ results, expected }) => {
    // Forward compatibility: the current server does not emit warnings in semantic mode.
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ results, warning }));
    vi.stubGlobal('fetch', fetchMock);
    const tool = await initializeTool('cypher');
    const output = await tool.invoke({
      query: 'authentication',
      cypher: 'MATCH (n) RETURN {{QUERY_VECTOR}}',
    });
    expect(output.startsWith(`Search warning: ${warning}\nResults may be incomplete.\n\n`)).toBe(
      true,
    );
    expect(output.match(/Search warning:/g)).toHaveLength(1);
    expect(output).toContain(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://search-client.test:4747/api/search');
    expect(JSON.parse(init?.body as string)).toEqual({
      query: 'authentication',
      limit: 10,
      mode: 'semantic',
      repo: '/work/app',
    });
  });

  it('keeps the array result contract for non-agent search callers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ results: [match], warning })),
    );
    await expect(search('authentication')).resolves.toEqual([match]);
  });
});
