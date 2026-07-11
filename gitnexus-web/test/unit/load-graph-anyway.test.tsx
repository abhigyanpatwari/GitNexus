import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';
import { getActiveProviderConfig } from '../../src/core/llm/settings-service';
import { buildCodebaseContext, type CodebaseContext } from '../../src/core/llm/context-builder';

// Capture initializeAgent's observable seam: buildCodebaseContext receives the
// effective project name that ends up in the agent's system prompt.
vi.mock('../../src/core/llm/context-builder', () => ({
  buildCodebaseContext: vi.fn(
    async (): Promise<CodebaseContext> => ({
      stats: {
        projectName: 'stub',
        fileCount: 0,
        functionCount: 0,
        classCount: 0,
        interfaceCount: 0,
        methodCount: 0,
      },
      hotspots: [],
      folderTree: '',
    }),
  ),
}));

vi.mock('../../src/core/llm/agent', () => ({
  createGraphRAGAgent: vi.fn(() => ({})),
}));

vi.mock('../../src/core/llm/settings-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/llm/settings-service')>();
  // Wrap with the real implementation so tests without an explicit override
  // keep today's no-provider (null) behavior.
  return { ...actual, getActiveProviderConfig: vi.fn(actual.getActiveProviderConfig) };
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reset the URL mutated by loadGraphAnyway's persistence.
  window.history.replaceState(null, '', '/');
});

const repoInfoResponse = () =>
  new Response(
    JSON.stringify({
      name: 'big-repo',
      path: '/r/big-repo',
      repoPath: '/r/big-repo',
      indexedAt: '2026-06-13T00:00:00Z',
      stats: { nodes: 300_000, edges: 600_000 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

const graphNdjsonResponse = () => {
  const body =
    '{"type":"node","data":{"id":"File:a.ts","label":"File","properties":{"name":"a.ts","filePath":"a.ts"}}}\n' +
    '{"type":"relationship","data":{"id":"r1","type":"CONTAINS","sourceId":"File:a.ts","targetId":"File:a.ts"}}\n';
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
};

describe('loadGraphAnyway (chat-only escape hatch, #2178)', () => {
  it('forces a full graph download and flips graphMode back to full', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo')) return Promise.resolve(repoInfoResponse());
      if (url.includes('/api/graph')) return Promise.resolve(graphNdjsonResponse());
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });

    act(() => {
      result.current.setServerBaseUrl('http://localhost:4747');
      result.current.setCurrentRepo('big-repo');
      result.current.setGraphMode('chatOnly');
    });

    await act(async () => {
      await result.current.loadGraphAnyway();
    });

    // Despite the 300K node count, skipGraph:false forces the download.
    expect(result.current.graphMode).toBe('full');
    expect(result.current.graph?.nodeCount).toBe(1);
    const graphCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/graph'));
    expect(graphCalls.length).toBeGreaterThan(0);
    // The override is session-scoped — deliberately NOT persisted to the URL, so
    // it cannot leak onto a different repo or re-trigger the hang on F5 (#2178).
    expect(window.location.search).not.toContain('skipGraph');
  });

  it('no-ops when there is no server connection', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });

    await act(async () => {
      await result.current.loadGraphAnyway();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('guards against a concurrent double-invocation (only one download)', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo')) return Promise.resolve(repoInfoResponse());
      if (url.includes('/api/graph')) return Promise.resolve(graphNdjsonResponse());
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    act(() => {
      result.current.setServerBaseUrl('http://localhost:4747');
      result.current.setCurrentRepo('big-repo');
      result.current.setGraphMode('chatOnly');
    });

    await act(async () => {
      // Fire twice synchronously — the second call must be dropped by the guard.
      const a = result.current.loadGraphAnyway();
      const b = result.current.loadGraphAnyway();
      await Promise.all([a, b]);
    });

    const graphCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/graph'));
    expect(graphCalls).toHaveLength(1);
  });

  it('stays in chat-only mode when the full-graph download fails', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo')) return Promise.resolve(repoInfoResponse());
      if (url.includes('/api/graph'))
        return Promise.resolve(new Response('{"error":"boom"}', { status: 500 }));
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    act(() => {
      result.current.setServerBaseUrl('http://localhost:4747');
      result.current.setCurrentRepo('big-repo');
      result.current.setGraphMode('chatOnly');
    });

    await act(async () => {
      await result.current.loadGraphAnyway();
    });

    // Failure leaves the user in chat-only mode (overlay reappears), view restored.
    expect(result.current.graphMode).toBe('chatOnly');
    expect(result.current.viewMode).toBe('exploring');
    expect(window.location.search).not.toContain('skipGraph=0');
  });

  it('discards a stale result when the active repo changed mid-load', async () => {
    let resolveGraph: (r: Response) => void = () => {};
    const graphPromise = new Promise<Response>((res) => {
      resolveGraph = res;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo')) return Promise.resolve(repoInfoResponse());
      if (url.includes('/api/graph')) return graphPromise;
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    act(() => {
      result.current.setServerBaseUrl('http://localhost:4747');
      result.current.setCurrentRepo('repo-A');
      result.current.setGraphMode('chatOnly');
    });

    let loadPromise: Promise<void> = Promise.resolve();
    act(() => {
      loadPromise = result.current.loadGraphAnyway(); // captures repo-A
    });
    // A concurrent switch changes the active repo while the load is in flight.
    act(() => {
      result.current.setCurrentRepo('repo-B');
    });
    await act(async () => {
      resolveGraph(graphNdjsonResponse());
      await loadPromise;
    });

    // The stale repo-A result must NOT flip the (now repo-B) view to full.
    expect(result.current.graphMode).toBe('chatOnly');
  });

  it('re-initializes the agent with the looked-up display name and the path identity', async () => {
    vi.mocked(getActiveProviderConfig).mockReturnValue({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
    });
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo')) return Promise.resolve(repoInfoResponse());
      if (url.includes('/api/graph')) return Promise.resolve(graphNdjsonResponse());
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    act(() => {
      result.current.setServerBaseUrl('http://localhost:4747');
      result.current.setAvailableRepos([
        {
          name: 'reels-display',
          path: '/r/big-repo',
          repoPath: '/r/big-repo',
          indexedAt: '2026-06-13T00:00:00Z',
        },
      ]);
      result.current.setCurrentRepo('/r/big-repo');
      result.current.setGraphMode('chatOnly');
    });

    await act(async () => {
      await result.current.loadGraphAnyway();
    });

    // The agent prompt gets the human-readable display name — never the
    // absolute path, and never the 'project' literal that initializeAgent's
    // empty-deps closure would fall back to (projectName is trapped at '').
    expect(vi.mocked(buildCodebaseContext)).toHaveBeenCalledWith(
      expect.any(Function),
      'reels-display',
    );
    // The repo identity itself stays the path (threaded via opts.repo).
    expect(result.current.currentRepo).toBe('/r/big-repo');
  });

  it('falls back to the identity basename for the agent prompt when the repo list misses it', async () => {
    vi.mocked(getActiveProviderConfig).mockReturnValue({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
    });
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo')) return Promise.resolve(repoInfoResponse());
      if (url.includes('/api/graph')) return Promise.resolve(graphNdjsonResponse());
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    act(() => {
      result.current.setServerBaseUrl('http://localhost:4747');
      result.current.setCurrentRepo('/r/big-repo');
      result.current.setGraphMode('chatOnly');
    });

    await act(async () => {
      await result.current.loadGraphAnyway();
    });

    expect(vi.mocked(buildCodebaseContext)).toHaveBeenCalledWith(expect.any(Function), 'big-repo');
    expect(result.current.currentRepo).toBe('/r/big-repo');
  });

  it('does not throw or apply state when unmounted mid-load', async () => {
    let resolveGraph: (r: Response) => void = () => {};
    const graphPromise = new Promise<Response>((res) => {
      resolveGraph = res;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo')) return Promise.resolve(repoInfoResponse());
      if (url.includes('/api/graph')) return graphPromise;
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    act(() => {
      result.current.setServerBaseUrl('http://localhost:4747');
      result.current.setCurrentRepo('big-repo');
      result.current.setGraphMode('chatOnly');
    });

    let loadPromise: Promise<void> = Promise.resolve();
    act(() => {
      loadPromise = result.current.loadGraphAnyway();
    });
    unmount(); // fires cleanup: mountedRef=false + abort
    await act(async () => {
      resolveGraph(graphNdjsonResponse());
      await loadPromise; // resolves without setState-after-unmount throwing
    });
  });
});

describe('switchRepo auto-detect (chat-only, #2178)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('enters chat-only mode and captures the node count for a large repo', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo')) return Promise.resolve(repoInfoResponse());
      if (url.includes('/api/repos'))
        return Promise.resolve(
          new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
        );
      if (url.includes('/api/graph')) return Promise.resolve(graphNdjsonResponse());
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    act(() => {
      result.current.setServerBaseUrl('http://localhost:4747');
    });

    await act(async () => {
      await result.current.switchRepo('big-repo');
    });

    // 300K nodes > threshold → auto-skip, empty graph, count captured, no graph download.
    expect(result.current.graphMode).toBe('chatOnly');
    expect(result.current.graph?.nodeCount).toBe(0);
    expect(result.current.chatOnlyNodeCount).toBe(300_000);
    const graphCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/graph'));
    expect(graphCalls).toHaveLength(0);
  });
});
