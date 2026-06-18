/**
 * End-to-end HTTP test of POST /api/analyze token validation.
 *
 * The unit tests (api-analyze-token.test.ts) cover validateAnalyzeToken in
 * isolation; this proves the REAL production route actually wires it in —
 * express.json body parsing, the requireLocalhostOrigin guard, the route
 * handler invoking the validator, and the 400 status/error shape on the wire.
 * Closes the gap the PR #2223 tri-review noted: "the route validation is
 * otherwise only reachable by booting the server."
 *
 * Only rejection paths are asserted: each returns 400 BEFORE any clone, so the
 * test is hermetic (no network, no background git, no real repo). The accepted
 * path would spawn a background clone and is left to the unit coverage.
 *
 * Mirrors the spawn+health-poll harness in server-http-startup.test.ts; the
 * integration suite always builds dist first (pretest:integration).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_CLI = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');
const STARTUP_BUDGET_MS = process.env.CI ? 30_000 : 15_000;

const allocateFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (typeof addr !== 'object' || !addr) {
        probe.close();
        reject(new Error('could not allocate ephemeral port'));
        return;
      }
      const port = addr.port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

const httpJson = (
  port: number,
  method: string,
  reqPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5_000, () => {
      req.destroy();
      reject(new Error(`${method} ${reqPath} timed out`));
    });
    if (payload) req.write(payload);
    req.end();
  });

const postAnalyze = (port: number, body: unknown) => httpJson(port, 'POST', '/api/analyze', body);

// Spawned `serve` on Windows can report ready before the socket is reachable
// from the parent (see server-http-startup.test.ts); the validateAnalyzeToken
// unit tests cover the validation logic on every platform.
const describeBlock = process.platform === 'win32' ? describe.skip : describe;

describeBlock('POST /api/analyze token validation (real server)', () => {
  let proc: ChildProcessWithoutNullStreams | undefined;
  let homeDir: string | undefined;
  let port = 0;

  beforeAll(async () => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(`Missing ${DIST_CLI} — run npm run build before integration tests`);
    }

    port = await allocateFreePort();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-analyze-token-'));

    proc = spawn(
      process.execPath,
      [DIST_CLI, 'serve', '--port', String(port), '--host', '127.0.0.1'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, GITNEXUS_HOME: homeDir, NODE_OPTIONS: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    proc.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < STARTUP_BUDGET_MS) {
      if (proc.exitCode !== null) {
        throw new Error(`serve exited ${proc.exitCode} before ready.\nstderr:\n${stderr}`);
      }
      try {
        const { status } = await httpJson(port, 'GET', '/api/health');
        if (status === 200) return;
      } catch {
        // Server still starting — retry until budget expires.
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `serve did not become ready within ${STARTUP_BUDGET_MS}ms.\nstderr:\n${stderr}`,
    );
  }, 60_000);

  afterAll(async () => {
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc?.kill('SIGKILL');
          resolve();
        }, 3_000);
        proc?.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    proc = undefined;
    if (homeDir) {
      fs.rmSync(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  it('rejects a GitHub token paired with a non-github host (finding 6)', async () => {
    const { status, body } = await postAnalyze(port, {
      url: 'https://gitlab.com/owner/repo',
      token: 'ghp_validformat123',
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toContain('only supported for github.com');
  });

  it('rejects a GitHub token paired with an Azure DevOps URL (cross-credential trigger)', async () => {
    const { status, body } = await postAnalyze(port, {
      url: 'https://dev.azure.com/org/proj/_git/repo',
      token: 'ghp_validformat123',
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toContain('only supported for github.com');
  });

  it('rejects a token whose characters could smuggle a header (CRLF/space)', async () => {
    const { status, body } = await postAnalyze(port, {
      url: 'https://github.com/owner/repo',
      token: 'bad token',
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toContain('invalid characters');
  });

  it('rejects a token with no url (routed via a path so it reaches token validation)', async () => {
    const { status, body } = await postAnalyze(port, {
      path: '/tmp/gitnexus-nonexistent-abs-path',
      token: 'ghp_validformat123',
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toContain('requires "url"');
  });

  it('still rejects a request with neither url nor path (route reachable, json parsed)', async () => {
    const { status, body } = await postAnalyze(port, {});
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toContain('Provide');
  });
});
