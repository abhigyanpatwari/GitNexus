/**
 * End-to-end HTTP test of the branch/freshness fields on the repo routes (#3226).
 *
 * `repo-projection.test.ts` covers the projections in isolation. This proves the
 * REAL routes call them — the gap the #3199 review named directly ("the actual
 * glue, and nothing asserts it"): a unit test of a projection stays green if the
 * route stops using it, which is exactly how `branch` sat on `RegistryEntry`
 * unexposed while `gitnexus list` printed it.
 *
 * The fixture is a real git repository with two commits, registered with
 * `lastCommit` pinned to the FIRST one, so `git rev-list --count <first>..HEAD`
 * has a genuine answer (1) rather than a trivial zero. No index is written: both
 * routes read the registry, and `loadMeta` returning null is a case the
 * projection must already handle.
 *
 * Mirrors the spawn+health-poll harness in server-analyze-branch-validation.test.ts.
 */
import { execFileSync } from 'node:child_process';
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
const REPO_NAME = 'freshness-fixture';
const INDEXED_AT = '2026-09-08T10:00:00.000Z';

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

const httpJson = (port: number, reqPath: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.setTimeout(5_000, () => {
      req.destroy();
      reject(new Error(`GET ${reqPath} timed out`));
    });
    req.end();
  });

// Spawned `serve` on Windows can report ready before the socket is reachable
// from the parent (see server-http-startup.test.ts).
const describeBlock = process.platform === 'win32' ? describe.skip : describe;

describeBlock('repo routes expose branch and freshness (real server)', () => {
  let proc: ChildProcessWithoutNullStreams | undefined;
  let homeDir: string | undefined;
  let port = 0;

  beforeAll(async () => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(`Missing ${DIST_CLI} — run npm run build before integration tests`);
    }

    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-freshness-'));
    const repoPath = path.join(homeDir, 'repos', REPO_NAME);
    fs.mkdirSync(repoPath, { recursive: true });

    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'GitNexus Test');
    fs.writeFileSync(path.join(repoPath, 'a.js'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'first');
    const firstCommit = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repoPath, 'b.js'), 'export const b = 2;\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'second');

    // The storage directory must exist: `serve` prunes registry rows whose
    // `storagePath` is gone, so a fixture without it is silently dropped and the
    // route legitimately returns nothing (found while writing this test).
    const storagePath = path.join(repoPath, '.gitnexus');
    fs.mkdirSync(path.join(storagePath, 'lbug'), { recursive: true });
    fs.writeFileSync(
      path.join(storagePath, 'gitnexus.json'),
      JSON.stringify({
        repoPath,
        storagePath,
        indexedAt: INDEXED_AT,
        lastCommit: firstCommit,
        branch: 'main',
        stats: { files: 1, nodes: 2, edges: 1 },
      }),
    );

    // Registered as if indexed at the FIRST commit: one commit behind HEAD.
    fs.writeFileSync(
      path.join(homeDir, 'registry.json'),
      JSON.stringify([
        {
          name: REPO_NAME,
          path: repoPath,
          storagePath,
          indexedAt: INDEXED_AT,
          lastCommit: firstCommit,
          branch: 'main',
          stats: { files: 1, nodes: 2, edges: 1 },
        },
      ]),
    );

    port = await allocateFreePort();
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
        const { status } = await httpJson(port, '/api/health');
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

  it('GET /api/repos returns branch and a real commits-behind count', async () => {
    const { status, body } = await httpJson(port, '/api/repos');
    expect(status).toBe(200);
    const entry = JSON.parse(body).find((r: { name: string }) => r.name === REPO_NAME);
    expect(entry).toBeDefined();
    expect(entry.branch).toBe('main');
    // Genuinely computed by `git rev-list`, not a fixture constant.
    expect(entry.staleness).toEqual({
      status: 'behind',
      commitsBehind: 1,
      hint: expect.stringContaining('1 commit behind'),
    });
  });

  it('GET /api/repos still returns the fields it always did', async () => {
    // Additive only — an existing client must not notice this change.
    const { body } = await httpJson(port, '/api/repos');
    const entry = JSON.parse(body).find((r: { name: string }) => r.name === REPO_NAME);
    expect(entry).toMatchObject({
      name: REPO_NAME,
      path: expect.any(String),
      repoPath: expect.any(String),
      indexedAt: expect.any(String),
      lastCommit: expect.any(String),
      stats: expect.any(Object),
    });
  });

  it('GET /api/repo returns lastCommit and branch, which it used to drop', async () => {
    const { status, body } = await httpJson(port, `/api/repo?repo=${REPO_NAME}`);
    expect(status).toBe(200);
    const repo = JSON.parse(body);
    expect(repo.lastCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.branch).toBe('main');
    expect(repo.staleness).toEqual({
      status: 'behind',
      commitsBehind: 1,
      hint: expect.stringContaining('1 commit behind'),
    });
  });
});
