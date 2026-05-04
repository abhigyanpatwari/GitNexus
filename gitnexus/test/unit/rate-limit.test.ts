/**
 * Tests for createRouteLimiter and the integration shape used by api.ts.
 *
 * Closes the U4 test gap (CodeQL js/missing-rate-limiting alerts #180,
 * #181, #183, #444). Without these, a refactor that drops the limiter
 * middleware from any route would silently regress and CodeQL would
 * re-fire — but no test would fail before reaching CI.
 *
 * The route-level test mounts a minimal handler that does fs.readFile (the
 * exact pattern CodeQL flags as a sink) behind createRouteLimiter, then
 * sends max+1 requests via direct handler invocation through a real
 * express app. Only one route is exercised because the same wrapper is
 * shared across all four flagged routes — proving wiring once is enough
 * for shape coverage; per-route accidental-omission would surface as a
 * CodeQL re-flag of that specific route, not as a behavior regression.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createRouteLimiter, DEFAULT_RATE_LIMIT_RPM } from '../../src/server/validation.js';

let server: http.Server;
let baseUrl: string;
let tmpFile: string;

beforeAll(async () => {
  // Real fs.readFile target so the route does the same kind of FS work
  // the production routes do — keeps the test honest about what it covers.
  tmpFile = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-ratelimit-')),
    'fixture.txt',
  );
  await fs.writeFile(tmpFile, 'hello\n', 'utf-8');

  const app = express();
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  // Tight test policy — 3 requests / 1 second window — so the test runs
  // in well under a second and the 4th request reliably trips 429.
  app.get('/test/file', createRouteLimiter({ windowMs: 1000, max: 3 }), async (_req, res) => {
    const content = await fs.readFile(tmpFile, 'utf-8');
    res.json({ content });
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
  await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
});

describe('createRouteLimiter — defaults', () => {
  it('exports DEFAULT_RATE_LIMIT_RPM = 60', () => {
    expect(DEFAULT_RATE_LIMIT_RPM).toBe(60);
  });

  it('returns a different middleware instance per call (independent counters)', () => {
    const a = createRouteLimiter();
    const b = createRouteLimiter();
    expect(a).not.toBe(b);
  });

  it('produces a callable express RequestHandler', () => {
    const limiter = createRouteLimiter();
    expect(typeof limiter).toBe('function');
    // express middleware signature is (req, res, next) — 3 args.
    expect(limiter.length).toBe(3);
  });
});

describe('createRouteLimiter — integration with a real route', () => {
  // The exact regression guard CodeQL would re-fire if a maintainer
  // dropped createRouteLimiter from any of the 4 protected routes:
  // without the limiter, max+1 requests all return 200.
  it('lets max requests through and rejects the next one with 429', async () => {
    // 3 within the window — all 200.
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${baseUrl}/test/file`);
      expect(res.status).toBe(200);
    }
    // 4th — 429.
    const res = await fetch(`${baseUrl}/test/file`);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Too many');
  });

  it('emits draft-7 RateLimit-* response headers, not legacy X-RateLimit-*', async () => {
    // Wait out the previous test's window so we get fresh headers.
    await new Promise((r) => setTimeout(r, 1100));
    const res = await fetch(`${baseUrl}/test/file`);
    expect(res.status).toBe(200);
    // draft-7 uses RateLimit (not X-RateLimit-) and a single combined header.
    expect(res.headers.get('ratelimit')).toBeTruthy();
    expect(res.headers.get('x-ratelimit-limit')).toBeNull();
  });

  it('429 response body uses the project { error } JSON shape', async () => {
    // Trip the limiter again.
    for (let i = 1; i <= 3; i++) await fetch(`${baseUrl}/test/file`);
    const res = await fetch(`${baseUrl}/test/file`);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: expect.stringContaining('Too many') });
  });
});
