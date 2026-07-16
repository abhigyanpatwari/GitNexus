/**
 * Canonical repo identity (#2419).
 *
 * `repoIdentity` is the single identity helper for the web app: the registry
 * path is canonical because the display `name` is ambiguous across duplicate
 * repo names. `fetchRepos` must normalize legacy list-endpoint entries
 * (`path` only) onto the `repoPath` field, mirroring `fetchRepoInfo`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetBreakerRegistry__ } from 'gitnexus-shared/test-helpers';
import {
  fetchRepos,
  repoIdentity,
  setBackendUrl,
  type BackendRepo,
} from '../../src/services/backend-client';

const BASE = 'http://repo-identity.test:4747';

describe('repoIdentity fallback chain', () => {
  it('prefers repoPath when present', () => {
    const repo: BackendRepo = {
      name: 'reels',
      path: '/ws/group-a/reels',
      repoPath: '/ws/group-b/reels',
      indexedAt: '2026-07-10T00:00:00.000Z',
    };
    expect(repoIdentity(repo)).toBe('/ws/group-b/reels');
  });

  it('falls back to path when repoPath is absent', () => {
    const repo: BackendRepo = {
      name: 'reels',
      path: '/ws/group-a/reels',
      indexedAt: '2026-07-10T00:00:00.000Z',
    };
    expect(repoIdentity(repo)).toBe('/ws/group-a/reels');
  });

  it('falls back to the display name when neither path field is present', () => {
    // Legacy payloads can omit both path fields at runtime even though the
    // interface marks `path` required — assert the narrow legacy shape to
    // exercise the final fallback without weakening the helper's signature.
    const legacyRepo = {
      name: 'reels',
      indexedAt: '2026-07-10T00:00:00.000Z',
    } as BackendRepo;
    expect(repoIdentity(legacyRepo)).toBe('reels');
  });
});

describe('fetchRepos repoPath normalization', () => {
  beforeEach(() => {
    __resetBreakerRegistry__();
    setBackendUrl(BASE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps legacy path-only entries onto repoPath', async () => {
    const legacyBody = JSON.stringify([
      { name: 'reels', path: '/ws/group-a/reels', indexedAt: '2026-07-10T00:00:00.000Z' },
      { name: 'docs', path: '/ws/group-b/docs', indexedAt: '2026-07-09T00:00:00.000Z' },
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/api/repos');
      return new Response(legacyBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const repos = await fetchRepos();
    expect(repos).toMatchObject([
      { name: 'reels', path: '/ws/group-a/reels', repoPath: '/ws/group-a/reels' },
      { name: 'docs', path: '/ws/group-b/docs', repoPath: '/ws/group-b/docs' },
    ]);
  });

  it('keeps a server-provided repoPath over the legacy path field', async () => {
    const body = JSON.stringify([
      {
        name: 'reels',
        path: '/ws/group-a/reels',
        repoPath: '/ws/group-b/reels',
        indexedAt: '2026-07-10T00:00:00.000Z',
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const repos = await fetchRepos();
    expect(repos).toMatchObject([{ name: 'reels', repoPath: '/ws/group-b/reels' }]);
  });
});
