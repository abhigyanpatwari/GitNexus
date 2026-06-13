import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectToServer,
  fetchGraph,
  getBackendUrl,
  normalizeServerUrl,
  setBackendUrl,
  validateBackendUrl,
} from '../../src/services/backend-client';

describe('normalizeServerUrl', () => {
  it('adds http:// to localhost', () => {
    expect(normalizeServerUrl('localhost:4747')).toBe('http://localhost:4747');
  });

  it('adds http:// to 127.0.0.1', () => {
    expect(normalizeServerUrl('127.0.0.1:4747')).toBe('http://127.0.0.1:4747');
  });

  it('adds https:// to non-local hosts', () => {
    expect(normalizeServerUrl('example.com')).toBe('https://example.com');
  });

  it('strips trailing slashes', () => {
    expect(normalizeServerUrl('http://localhost:4747/')).toBe('http://localhost:4747');
    expect(normalizeServerUrl('http://localhost:4747///')).toBe('http://localhost:4747');
  });

  it('strips /api suffix (base URL only)', () => {
    expect(normalizeServerUrl('http://localhost:4747/api')).toBe('http://localhost:4747');
  });

  it('trims whitespace', () => {
    expect(normalizeServerUrl('  localhost:4747  ')).toBe('http://localhost:4747');
  });

  it('preserves existing https://', () => {
    expect(normalizeServerUrl('https://gitnexus.example.com')).toBe('https://gitnexus.example.com');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchGraph', () => {
  it('requests streamed graph responses from the backend', async () => {
    setBackendUrl('http://localhost:4747');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"nodes":[],"relationships":[]}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchGraph('big-repo');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/graph?repo=big-repo&stream=true'),
      expect.any(Object),
    );
  });

  it('parses NDJSON graph streams incrementally', async () => {
    setBackendUrl('http://localhost:4747');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              '{"type":"node","data":{"id":"File:src/app.ts","label":"File","properties":{"name":"app.ts","filePath":"src/app.ts"}}}\n',
              '{"type":"relationship","data":{"id":"File:src/app.ts_CONTAINS_Function:src/app.ts:main","type":"CONTAINS","sourceId":"File:src/app.ts","targetId":"Function:src/app.ts:main"}}\n',
            ].join(''),
          ),
        );
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson',
          },
        }),
      ),
    );

    const progress = vi.fn();
    const result = await fetchGraph('big-repo', { onProgress: progress });

    expect(result.nodes).toHaveLength(1);
    expect(result.relationships).toHaveLength(1);
    expect(result.nodes[0].id).toBe('File:src/app.ts');
    expect(result.relationships[0].type).toBe('CONTAINS');
    expect(progress).toHaveBeenCalled();
  });

  it('parses NDJSON graph lines split across chunks', async () => {
    setBackendUrl('http://localhost:4747');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            '{"type":"node","data":{"id":"File:src/app.ts","label":"File","properties":{"name":"app.ts"',
          ),
        );
        controller.enqueue(
          encoder.encode(
            ',"filePath":"src/app.ts"}}}\n{"type":"relationship","data":{"id":"File:src/app.ts_CONTAINS_Function:src/app.ts:main","type":"CONTAINS","sourceId":"File:src/app.ts","targetId":"Function:src/app.ts:main"}}\n',
          ),
        );
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson',
          },
        }),
      ),
    );

    const result = await fetchGraph('big-repo');

    expect(result.nodes).toHaveLength(1);
    expect(result.relationships).toHaveLength(1);
    expect(result.nodes[0].properties.filePath).toBe('src/app.ts');
  });

  it('throws backend errors emitted in the NDJSON stream', async () => {
    setBackendUrl('http://localhost:4747');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"error","error":"stream failed"}\n'));
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson',
          },
        }),
      ),
    );

    await expect(fetchGraph('big-repo')).rejects.toMatchObject({
      message: 'stream failed',
    });
  });
});

describe('connectToServer skipGraph (chat-only mode)', () => {
  const repoInfo = (nodes: number | undefined) => ({
    name: 'big-repo',
    path: '/repos/big-repo',
    repoPath: '/repos/big-repo',
    indexedAt: '2026-06-13T00:00:00Z',
    ...(nodes !== undefined ? { stats: { nodes, edges: nodes * 2 } } : {}),
  });

  // Routes /api/repo to the repo info and /api/graph to the supplied handler;
  // any other path returns an empty 200 so the breaker stays closed.
  const makeFetchMock = (nodes: number | undefined) => {
    const graphHandler = vi.fn(
      () =>
        new Response('{"nodes":[],"relationships":[]}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo')) {
        return Promise.resolve(
          new Response(JSON.stringify(repoInfo(nodes)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/api/graph')) {
        return Promise.resolve(graphHandler());
      }
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    });
    return { fetchMock, graphHandler };
  };

  const graphRequests = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([u]: unknown[]) => String(u).includes('/api/graph'));

  it('skips the graph download when skipGraph is true (even for a tiny repo)', async () => {
    const { fetchMock } = makeFetchMock(5);
    vi.stubGlobal('fetch', fetchMock);

    const result = await connectToServer(
      'http://localhost:4747',
      undefined,
      undefined,
      'big-repo',
      {
        skipGraph: true,
      },
    );

    expect(result.graphSkipped).toBe(true);
    expect(result.nodes).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.repoInfo.name).toBe('big-repo');
    expect(graphRequests(fetchMock)).toHaveLength(0);
  });

  it('downloads the graph when skipGraph is false (even for a huge repo)', async () => {
    const { fetchMock } = makeFetchMock(300_000);
    vi.stubGlobal('fetch', fetchMock);

    const result = await connectToServer(
      'http://localhost:4747',
      undefined,
      undefined,
      'big-repo',
      {
        skipGraph: false,
      },
    );

    expect(result.graphSkipped).toBe(false);
    expect(graphRequests(fetchMock).length).toBeGreaterThan(0);
  });

  it('auto-detects a large project and skips the graph (no explicit flag)', async () => {
    const { fetchMock } = makeFetchMock(300_000);
    vi.stubGlobal('fetch', fetchMock);

    const result = await connectToServer('http://localhost:4747', undefined, undefined, 'big-repo');

    expect(result.graphSkipped).toBe(true);
    expect(graphRequests(fetchMock)).toHaveLength(0);
  });

  it('downloads the graph for a small project (no explicit flag)', async () => {
    const { fetchMock } = makeFetchMock(500);
    vi.stubGlobal('fetch', fetchMock);

    const result = await connectToServer('http://localhost:4747', undefined, undefined, 'big-repo');

    expect(result.graphSkipped).toBe(false);
    expect(graphRequests(fetchMock).length).toBeGreaterThan(0);
  });

  it('fails open to a full download when node stats are missing', async () => {
    const { fetchMock } = makeFetchMock(undefined);
    vi.stubGlobal('fetch', fetchMock);

    const result = await connectToServer('http://localhost:4747', undefined, undefined, 'big-repo');

    expect(result.graphSkipped).toBe(false);
    expect(graphRequests(fetchMock).length).toBeGreaterThan(0);
  });
});

describe('DEFAULT_BACKEND_URL resolution', () => {
  afterEach(() => {
    delete window.__GITNEXUS_CONFIG__;
    vi.resetModules();
  });

  it('falls back to localhost:4747 when no config is injected', async () => {
    delete window.__GITNEXUS_CONFIG__;
    const { DEFAULT_BACKEND_URL } = await import('../../src/config/ui-constants');
    expect(DEFAULT_BACKEND_URL).toBe('http://localhost:4747');
  });

  it('uses window.__GITNEXUS_CONFIG__.backendUrl when set', async () => {
    window.__GITNEXUS_CONFIG__ = { backendUrl: 'http://10.0.0.1:4747' };
    const { DEFAULT_BACKEND_URL } = await import('../../src/config/ui-constants');
    expect(DEFAULT_BACKEND_URL).toBe('http://10.0.0.1:4747');
  });

  it('falls back to localhost:4747 when config object has no backendUrl', async () => {
    window.__GITNEXUS_CONFIG__ = {};
    const { DEFAULT_BACKEND_URL } = await import('../../src/config/ui-constants');
    expect(DEFAULT_BACKEND_URL).toBe('http://localhost:4747');
  });

  it('falls back to localhost:4747 when backendUrl is an empty string', async () => {
    window.__GITNEXUS_CONFIG__ = { backendUrl: '' };
    const { DEFAULT_BACKEND_URL } = await import('../../src/config/ui-constants');
    expect(DEFAULT_BACKEND_URL).toBe('http://localhost:4747');
  });
});

describe('validateBackendUrl', () => {
  it('allows http:// URLs', () => {
    expect(() => validateBackendUrl('http://localhost:4747')).not.toThrow();
    expect(() => validateBackendUrl('http://127.0.0.1:4747')).not.toThrow();
  });

  it('allows https:// URLs', () => {
    expect(() => validateBackendUrl('https://gitnexus.example.com')).not.toThrow();
    expect(() => validateBackendUrl('https://my-server.internal:4747')).not.toThrow();
  });

  it('rejects non-http schemes', () => {
    expect(() => validateBackendUrl('javascript:alert(1)')).toThrow('must use http:// or https://');
    expect(() => validateBackendUrl('file:///etc/passwd')).toThrow('must use http:// or https://');
    expect(() => validateBackendUrl('data:text/plain,evil')).toThrow(
      'must use http:// or https://',
    );
  });

  it('rejects malformed URLs', () => {
    expect(() => validateBackendUrl('not-a-url')).toThrow('Invalid backend URL');
  });

  it('does not include the raw URL in error messages (credential hygiene)', () => {
    const urlWithCreds = 'javascript:alert("sk-secret")';
    let msg = '';
    try {
      validateBackendUrl(urlWithCreds);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain('sk-secret');
    expect(msg).not.toContain(urlWithCreds);
  });
});

describe('setBackendUrl', () => {
  it('accepts valid http URLs', () => {
    expect(() => setBackendUrl('http://localhost:4747')).not.toThrow();
  });

  it('accepts valid https URLs', () => {
    expect(() => setBackendUrl('https://my-server.example.com')).not.toThrow();
  });

  it('rejects non-http/https schemes', () => {
    expect(() => setBackendUrl('javascript:alert(1)')).toThrow('must use http:// or https://');
    expect(() => setBackendUrl('file:///etc/passwd')).toThrow('must use http:// or https://');
  });

  it('does not mutate _backendUrl when validation fails', () => {
    setBackendUrl('http://localhost:4747');
    expect(() => setBackendUrl('javascript:alert(1)')).toThrow();
    expect(getBackendUrl()).toBe('http://localhost:4747');
  });
});
