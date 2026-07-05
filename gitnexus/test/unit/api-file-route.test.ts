/**
 * Unit tests for the /api/file handler — handleFileRequest.
 *
 * Calls the handler directly with mock req/res rather than mounting it on
 * an Express app and binding a port. This is an intentional design choice:
 *   - Mounting the handler via app.get(...) inside a test triggers CodeQL's
 *     js/missing-rate-limiting query, which is correct for production
 *     route handlers but a false positive on tests of the handler logic.
 *   - Direct invocation also runs faster (no port allocation, no listen)
 *     and exercises the same code path used in production via createServer.
 *
 * Covers the gaps the PR #1322 review identified:
 *   - `?path=a&path=b` (array form) returns 400, not 500 — proves the catch
 *     block correctly routes BadRequestError via statusFromError.
 *   - `?path=../../../etc/passwd` returns 403 — traversal rejection.
 *   - `?path=%2e%2e%2fsecret` (encoded traversal) returns 403 — Express
 *     decodes the query string before the handler sees it.
 *   - Valid relative path returns 200 with file content.
 *   - Missing path returns 400.
 *   - Common-prefix sibling escape returns 403 (the path.relative idiom
 *     catches what startsWith(root + sep) would have missed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { handleFileRequest } from '../../src/server/api.js';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-api-file-test-'));
  await fs.writeFile(path.join(tmpRoot, 'hello.txt'), 'hello world\n', 'utf-8');
  await fs.mkdir(path.join(tmpRoot, 'sub'), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, 'sub', 'nested.txt'), 'nested\n', 'utf-8');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// Minimal express-shaped mock that captures status() / json() calls in a
// shape compatible with the handler's expected interface. Returns the
// final status (default 200 for naked res.json) and JSON body.
const invoke = async (query: Record<string, unknown>): Promise<{ status: number; body: any }> => {
  let capturedStatus = 200;
  let capturedBody: any = undefined;
  const res = {
    status(code: number) {
      capturedStatus = code;
      return this;
    },
    json(body: any) {
      capturedBody = body;
    },
  };
  await handleFileRequest({ query }, res, tmpRoot);
  return { status: capturedStatus, body: capturedBody };
};

describe('handleFileRequest — security wiring', () => {
  it('returns 200 with content for a valid relative path', async () => {
    const { status, body } = await invoke({ path: 'hello.txt' });
    expect(status).toBe(200);
    expect(body.content).toBe('hello world\n');
  });

  it('returns 200 for a nested valid path', async () => {
    const { status, body } = await invoke({ path: 'sub/nested.txt' });
    expect(status).toBe(200);
    expect(body.content).toBe('nested\n');
  });

  it('returns 400 when path is missing', async () => {
    const { status, body } = await invoke({});
    expect(status).toBe(400);
    expect(body.error).toBe('Missing path');
  });

  it('returns 400 when path is an empty string', async () => {
    const { status, body } = await invoke({ path: '' });
    expect(status).toBe(400);
    expect(body.error).toBe('Missing path');
  });

  // Reproducer for the PR #1322 review's HIGH finding #1.
  // Before the catch-block fix this returned 500.
  it('returns 400 when path is an array (?path=a&path=b)', async () => {
    const { status, body } = await invoke({ path: ['a', 'b'] });
    expect(status).toBe(400);
    expect(body.error).toContain('path');
    expect(body.error).toContain('array');
  });

  it('returns 403 for parent-directory traversal', async () => {
    const { status, body } = await invoke({ path: '../../../etc/passwd' });
    expect(status).toBe(403);
    expect(body.error).toBe('Path traversal denied');
  });

  it('returns 403 for already-decoded traversal segments', async () => {
    // Express decodes the query string before the handler sees it, so the
    // analogue of a percent-encoded `%2e%2e%2f` arrives at the handler as
    // '../'. Confirm the barrier still rejects.
    const { status, body } = await invoke({ path: '../etc/passwd' });
    expect(status).toBe(403);
    expect(body.error).toBe('Path traversal denied');
  });

  it('returns 403 for an absolute path that escapes the root', async () => {
    const { status, body } = await invoke({ path: '/etc/passwd' });
    expect(status).toBe(403);
    expect(body.error).toBe('Path traversal denied');
  });

  it('returns 404 for a path that resolves inside root but does not exist', async () => {
    const { status, body } = await invoke({ path: 'does-not-exist.txt' });
    expect(status).toBe(404);
    expect(body.error).toBe('File not found');
  });

  it('rejects a common-prefix sibling directory escape (path.relative idiom)', async () => {
    // The classic pitfall of `startsWith(root + sep)` is that '/tmp/repo' does
    // not catch '/tmp/repo-evil/x'. The path.relative idiom does.
    const sibling = path.basename(tmpRoot) + '-evil/secret';
    const { status, body } = await invoke({ path: `../${sibling}` });
    expect(status).toBe(403);
    expect(body.error).toBe('Path traversal denied');
  });
});
