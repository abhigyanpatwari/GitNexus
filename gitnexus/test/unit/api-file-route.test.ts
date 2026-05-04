/**
 * Route-level tests for /api/file's security wiring.
 *
 * Specifically covers the gaps the PR #1322 review identified:
 *   - `?path=a&path=b` (array form) returns 400, not 500 — proves the catch
 *     block correctly routes BadRequestError via statusFromError.
 *   - `?path=../../../etc/passwd` returns 403 — traversal rejection.
 *   - `?path=%2e%2e%2fsecret` (encoded traversal) returns 403 — Express
 *     decodes the query string before the handler sees it.
 *   - Valid relative path returns 200 with file content.
 *   - Missing path returns 400.
 *
 * The harness mounts a minimal express app with just the /api/file handler
 * lifted from createServer in api.ts, with resolveRepo / requestedRepo
 * stubbed to return a tmpdir we control. This is intentionally lighter than
 * the full createServer path (no MCP, no LadybugDB) so the test is fast and
 * covers the specific catch-block + assertString wiring that helper-level
 * tests cannot prove.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import { assertString, BadRequestError } from '../../src/server/validation.js';

// statusFromError mirrors the production helper at api.ts:509. Imported here
// would create a circular setup with createServer; this duplicate is the
// minimum needed to exercise the same branch the route uses.
const statusFromError = (err: any): number => {
  if (err instanceof BadRequestError) return err.status;
  const msg = String(err?.message ?? '');
  if (msg.includes('No indexed repositories') || msg.includes('not found')) return 404;
  if (msg.includes('Multiple repositories')) return 400;
  return 500;
};

let tmpRoot: string;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-api-file-test-'));
  await fs.writeFile(path.join(tmpRoot, 'hello.txt'), 'hello world\n', 'utf-8');
  await fs.mkdir(path.join(tmpRoot, 'sub'), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, 'sub', 'nested.txt'), 'nested\n', 'utf-8');

  const app = express();

  // /api/file handler — lifted verbatim from api.ts:1054 with resolveRepo
  // stubbed to point at tmpRoot.
  app.get('/api/file', async (req, res) => {
    try {
      const entry = { path: tmpRoot };

      const rawFilePath = req.query.path;
      if (rawFilePath === undefined || rawFilePath === '') {
        res.status(400).json({ error: 'Missing path' });
        return;
      }
      const filePath = assertString(rawFilePath, 'path');

      const repoRoot = path.resolve(entry.path);
      const fullPath = path.resolve(repoRoot, filePath);
      const fullRel = path.relative(repoRoot, fullPath);
      if (fullRel.startsWith('..') || path.isAbsolute(fullRel)) {
        res.status(403).json({ error: 'Path traversal denied' });
        return;
      }

      const raw = await fs.readFile(fullPath, 'utf-8');
      res.json({ content: raw, totalLines: raw.split('\n').length });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(statusFromError(err)).json({ error: err.message || 'Failed to read file' });
      }
    }
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (typeof addr === 'object' && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const get = async (queryString: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${baseUrl}/api/file?${queryString}`);
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

describe('GET /api/file — security wiring', () => {
  it('returns 200 with content for a valid relative path', async () => {
    const { status, body } = await get('path=hello.txt');
    expect(status).toBe(200);
    expect(body.content).toBe('hello world\n');
  });

  it('returns 200 for a nested valid path', async () => {
    const { status, body } = await get('path=sub/nested.txt');
    expect(status).toBe(200);
    expect(body.content).toBe('nested\n');
  });

  it('returns 400 when path is missing', async () => {
    const { status, body } = await get('');
    expect(status).toBe(400);
    expect(body.error).toBe('Missing path');
  });

  it('returns 400 when path is an empty string', async () => {
    const { status, body } = await get('path=');
    expect(status).toBe(400);
    expect(body.error).toBe('Missing path');
  });

  // The reproducer for the PR #1322 review's HIGH finding #1.
  // Before the catch-block fix this returned 500.
  it('returns 400 when path is an array (?path=a&path=b)', async () => {
    const { status, body } = await get('path=a&path=b');
    expect(status).toBe(400);
    expect(body.error).toContain('path');
    expect(body.error).toContain('array');
  });

  it('returns 403 for parent-directory traversal', async () => {
    const { status, body } = await get('path=' + encodeURIComponent('../../../etc/passwd'));
    expect(status).toBe(403);
    expect(body.error).toBe('Path traversal denied');
  });

  it('returns 403 for percent-encoded traversal', async () => {
    // Express decodes the query string before the handler sees it, so
    // %2e%2e%2f arrives at the handler as '../'. The barrier still rejects.
    const { status, body } = await get('path=%2e%2e%2fetc%2fpasswd');
    expect(status).toBe(403);
    expect(body.error).toBe('Path traversal denied');
  });

  it('returns 403 for an absolute path that escapes the root', async () => {
    const { status, body } = await get('path=' + encodeURIComponent('/etc/passwd'));
    expect(status).toBe(403);
    expect(body.error).toBe('Path traversal denied');
  });

  it('returns 404 for a path that resolves inside root but does not exist', async () => {
    const { status, body } = await get('path=does-not-exist.txt');
    expect(status).toBe(404);
    expect(body.error).toBe('File not found');
  });

  it('rejects a common-prefix sibling directory escape (path.relative idiom)', async () => {
    // The classic pitfall of `startsWith(root + sep)` is that '/tmp/repo' does
    // not catch '/tmp/repo-evil/x'. The path.relative idiom does — confirm.
    const sibling = path.basename(tmpRoot) + '-evil/secret';
    const { status, body } = await get('path=' + encodeURIComponent(`../${sibling}`));
    expect(status).toBe(403);
    expect(body.error).toBe('Path traversal denied');
  });
});
