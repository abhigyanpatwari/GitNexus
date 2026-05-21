/**
 * HTTP serve startup — proves createServer() boots under Express 5.
 *
 * Spawns the built CLI (`gitnexus serve`) and probes GET /api/health.
 * Catches regressions like invalid route patterns that throw at registration
 * time before LadybugDB or MCP initialize.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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

const probeHealth = (port: number): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(5_000, () => {
      req.destroy();
      reject(new Error('health probe timed out'));
    });
  });

// Child-process serve + health probe is reliable on Linux CI (where e2e failed).
// On Windows, spawned `serve` can print "running" before the listen socket is
// reachable from the parent; unit tests in server-cors-stack.test.ts cover the
// Express 5 registration path on all platforms.
const describeServeStartup = process.platform === 'win32' ? describe.skip : describe;

describeServeStartup('gitnexus serve HTTP startup (Express 5)', () => {
  let proc: ChildProcessWithoutNullStreams | undefined;
  let homeDir: string | undefined;

  afterEach(async () => {
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

  it('serve boots and GET /api/health returns ok', async () => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(`Missing ${DIST_CLI} — run npm run build before integration tests`);
    }

    const port = await allocateFreePort();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-serve-home-'));

    proc = spawn(
      process.execPath,
      [DIST_CLI, 'serve', '--port', String(port), '--host', '127.0.0.1'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, GITNEXUS_HOME: homeDir, NODE_OPTIONS: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (buf) => {
      stdout += buf.toString();
    });
    proc.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });

    const startedAt = Date.now();
    let status = 0;
    let body = '';

    while (Date.now() - startedAt < STARTUP_BUDGET_MS) {
      if (proc.exitCode !== null) {
        throw new Error(
          `serve exited ${proc.exitCode} before ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
      try {
        ({ status, body } = await probeHealth(port));
        if (status === 200) {
          break;
        }
      } catch {
        // Server still starting — retry until budget expires.
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(status).toBe(200);
    expect(body).toContain('"status":"ok"');
  }, 60_000);
});
