import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';

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
    // Persists the override so a refresh keeps the graph for this project.
    expect(window.location.search).toContain('skipGraph=0');
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
});
