/**
 * `/api/grep` client: query params and `timedOut` must reach callers.
 * Dropping `timedOut` made a 5s partial scan look like a complete miss.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetBreakerRegistry__ } from 'gitnexus-shared/test-helpers';
import { grep, setBackendUrl } from '../../src/services/backend-client';

const BASE = 'http://grep-client.test:4747';

describe('backend-client grep', () => {
  beforeEach(() => {
    __resetBreakerRegistry__();
    setBackendUrl(BASE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards fileFilter and caseSensitive and returns timedOut', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/api/grep?');
      expect(url).toContain(`pattern=${encodeURIComponent('sign|Sign')}`);
      expect(url).toContain(`fileFilter=${encodeURIComponent('src/api')}`);
      expect(url).toContain('caseSensitive=1');
      expect(url).toContain('limit=12');
      return new Response(
        JSON.stringify({
          results: [{ filePath: 'src/api.ts', line: 3, text: 'signOrder()' }],
          timedOut: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const body = await grep('sign|Sign', '/repo', 12, {
      fileFilter: 'src/api',
      caseSensitive: true,
    });
    expect(body.results).toEqual([{ filePath: 'src/api.ts', line: 3, text: 'signOrder()' }]);
    expect(body.timedOut).toBe(true);
  });

  it('omits timedOut when the server completed the scan', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const body = await grep('TODO');
    expect(body).toEqual({ results: [] });
  });

  it('does not send fileFilter when it is null or empty', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).not.toContain('fileFilter=');
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await grep('x', undefined, undefined, { fileFilter: '' });
    expect(fetchMock).toHaveBeenCalled();
  });
});
