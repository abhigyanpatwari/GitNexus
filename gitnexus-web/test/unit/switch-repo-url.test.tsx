import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';

afterEach(() => {
  vi.restoreAllMocks();
  // Reset the URL mutated by switchRepo's persistence.
  window.history.replaceState(null, '', '/');
});

// Duplicate-display-name repo: `name` alone cannot identify it (#2419), so the
// URL must carry the server-resolved path identity alongside the display name.
const repoInfoResponse = () =>
  new Response(
    JSON.stringify({
      name: 'reels',
      path: '/ws/group-b/reels',
      repoPath: '/ws/group-b/reels',
      indexedAt: '2026-07-10T00:00:00Z',
      stats: { nodes: 300_000, edges: 600_000 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

describe('switchRepo URL persistence (#2419)', () => {
  it('writes both the server-resolved repo path and the display name on success', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo')) return Promise.resolve(repoInfoResponse());
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
      await result.current.switchRepo('/ws/group-b/reels');
    });

    expect(window.location.search).toContain('repo=%2Fws%2Fgroup-b%2Freels');
    expect(window.location.search).toContain('project=reels');
    // A deliberate switch drops any per-repo skipGraph override (#2178).
    expect(window.location.search).not.toContain('skipGraph');
  });

  it('leaves the URL unchanged when the connect fails', async () => {
    window.history.replaceState(null, '', '/?repo=%2Fws%2Fgroup-a%2Freels&project=reels');
    const fetchMock = vi.fn(() => Promise.reject(new Error('connection refused')));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    act(() => {
      result.current.setServerBaseUrl('http://localhost:4747');
    });

    await act(async () => {
      await result.current.switchRepo('/ws/group-b/reels');
    });

    // The failed target must not poison the URL — a refresh still restores
    // the previously connected repo.
    expect(window.location.search).toBe('?repo=%2Fws%2Fgroup-a%2Freels&project=reels');
  });
});
