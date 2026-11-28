import { describe, expect, it, vi } from 'vitest';
import {
  EVAL_SERVER_TOOLS,
  rejectUnauthorizedRequest,
  reindexErrorStatus,
  reindexRepository,
} from '../../src/cli/eval-server.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';

function backendMock() {
  return {
    listRepos: vi.fn().mockResolvedValue([{ name: 'GitNexus' }]),
    callTool: vi.fn(),
  } as unknown as LocalBackend & {
    listRepos: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
  };
}

describe('eval-server POST /reindex', () => {
  it('returns only the documented success fields mapped from refresh_index', async () => {
    const backend = backendMock();
    backend.callTool.mockResolvedValue({
      status: 'refreshed',
      repo: 'GitNexus',
      durationMs: 123,
      indexedAt: '2026-11-27T00:00:00.000Z',
      lastCommit: 'abc123',
      staleness: { status: 'current' },
      stats: { files: 4 },
      extra: 'not forwarded',
    });

    const result = await reindexRepository(backend, '{"repo":"GitNexus"}', true);

    expect(result).toEqual({
      statusCode: 200,
      payload: {
        status: 'refreshed',
        repo: 'GitNexus',
        duration_ms: 123,
        indexedAt: '2026-11-27T00:00:00.000Z',
        lastCommit: 'abc123',
        staleness: { status: 'current' },
        stats: { files: 4 },
      },
    });
    expect(backend.callTool).toHaveBeenCalledWith('refresh_index', { repo: 'GitNexus' });
  });

  it('is opt-in and names the required environment variable when disabled', async () => {
    const backend = backendMock();
    const result = await reindexRepository(backend, '{"repo":"GitNexus"}', false);
    expect(result.statusCode).toBe(403);
    expect(result.payload.error).toContain('GITNEXUS_MCP_ENABLE_REFRESH=1');
    expect(backend.listRepos).not.toHaveBeenCalled();
  });

  it.each(['', '{', 'null', '[]'])('rejects invalid JSON input %j', async (body) => {
    const result = await reindexRepository(backendMock(), body, true);
    expect(result.statusCode).toBe(400);
  });

  it.each(['{}', '{"repo":null}', '{"repo":1}', '{"repo":"  "}'])(
    'rejects missing or non-string repo in %s',
    async (body) => {
      const result = await reindexRepository(backendMock(), body, true);
      expect(result.statusCode).toBe(400);
    },
  );

  it('returns 404 for a repository name not served by this backend', async () => {
    const backend = backendMock();
    const result = await reindexRepository(backend, '{"repo":"other"}', true);
    expect(result.statusCode).toBe(404);
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it.each([
    ['force', false],
    ['dry_run', true],
  ])('rejects %s before refreshing the index', async (key, value) => {
    const backend = backendMock();
    const result = await reindexRepository(
      backend,
      JSON.stringify({ repo: 'GitNexus', [key]: value }),
      true,
    );
    expect(result.statusCode).toBe(400);
    expect(result.payload.error).toContain(key);
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('maps already-running to 409 and backend failures to 500', async () => {
    const backend = backendMock();
    backend.callTool.mockResolvedValueOnce({ error: 'A refresh of GitNexus is already running.' });
    expect((await reindexRepository(backend, '{"repo":"GitNexus"}', true)).statusCode).toBe(409);

    backend.callTool.mockResolvedValueOnce({ error: 'worker failed' });
    expect((await reindexRepository(backend, '{"repo":"GitNexus"}', true)).statusCode).toBe(500);
  });

  it('maps unknown repo errors and keeps refresh_index out of the HTTP tool allowlist', () => {
    expect(reindexErrorStatus('Unknown repository')).toBe(404);
    expect(EVAL_SERVER_TOOLS.has('refresh_index')).toBe(false);
  });

  it('maps a refresh size-limit refusal to 422', () => {
    expect(
      reindexErrorStatus(
        "GitNexus has more than 5000 files in its working tree, over this server's refresh limit of 5000 (GITNEXUS_MCP_REFRESH_MAX_FILES). Run gitnexus analyze in the repository instead.",
      ),
    ).toBe(422);
  });

  it('requires the configured bearer token before dispatch', () => {
    const response = {
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    expect(rejectUnauthorizedRequest(undefined, 'secret', response)).toBe(true);
    expect(response.writeHead).toHaveBeenCalledWith(401);
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Unauthorized' }));
    expect(rejectUnauthorizedRequest('Bearer secret', 'secret', response)).toBe(false);
  });
});
