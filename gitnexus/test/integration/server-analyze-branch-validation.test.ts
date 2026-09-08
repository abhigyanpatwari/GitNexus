/**
 * End-to-end HTTP test of POST /api/analyze `branch` validation.
 *
 * `branch` is handed to `git` as a ref (`clone --branch`, `checkout -B`), so the
 * route validates it with the same `validateBranchName` the CLI's `--branch`
 * uses. This proves the REAL production route wires that in — express.json body
 * parsing, the requireTrustedOrigin guard, the route handler invoking the
 * validator, and the 400 status/error shape on the wire.
 *
 * Only rejection paths are asserted: each returns 400 BEFORE any clone, so the
 * test is hermetic (no network, no background git, no real repo). The accepted
 * path would spawn a background clone; the parent→worker half of it is covered
 * in test/unit/analyze-launch-collapse.test.ts, which asserts `branch` reaches
 * the worker's `AnalyzeOptions`.
 *
 * This lives in its own file rather than alongside the token cases because
 * /api/analyze is rate-limited to 10 requests/minute per IP — one spawned server
 * per concern keeps each suite clear of that ceiling.
 *
 * Mirrors the spawn+health-poll harness in server-analyze-token-validation.test.ts;
 * the integration suite always builds dist first (pretest:integration).
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
// from the parent (see server-http-startup.test.ts); validateBranchName's own
// unit coverage runs on every platform.
const describeBlock = process.platform === 'win32' ? describe.skip : describe;

describeBlock('POST /api/analyze branch validation (real server)', () => {
  let proc: ChildProcessWithoutNullStreams | undefined;
  let homeDir: string | undefined;
  let port = 0;

  beforeAll(async () => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(`Missing ${DIST_CLI} — run npm run build before integration tests`);
    }

    port = await allocateFreePort();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-analyze-branch-'));

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

  it('rejects a non-string branch', async () => {
    const { status, body } = await postAnalyze(port, {
      url: 'https://github.com/owner/repo',
      branch: 42,
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toContain('"branch" must be a string');
  });

  it('rejects a branch containing whitespace', async () => {
    const { status, body } = await postAnalyze(port, {
      url: 'https://github.com/owner/repo',
      branch: 'feature branch',
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toContain('whitespace');
  });

  it('rejects a branch using characters git forbids in a ref', async () => {
    const { status, body } = await postAnalyze(port, {
      url: 'https://github.com/owner/repo',
      branch: 'feature^bad',
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toContain('not allowed in a git ref');
  });

  it('rejects a branch that would read as a git option', async () => {
    // `git clone --branch --upload-pack=evil` would otherwise let a ref choose
    // the subprocess git runs; buildBranchCloneArgs keeps the `--` separator,
    // and this closes the same shape one layer earlier.
    const { status, body } = await postAnalyze(port, {
      url: 'https://github.com/owner/repo',
      branch: '--upload-pack=evil',
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toContain('must not start with "-"');
  });

  it('rejects a whitespace-only branch rather than silently indexing the default', async () => {
    // The bug this feature fixes was a silent fallback to the default branch;
    // an unusable selector must fail loudly, never degrade into that behavior.
    const { status, body } = await postAnalyze(port, {
      url: 'https://github.com/owner/repo',
      branch: '   ',
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toContain('must not be empty');
  });
});
