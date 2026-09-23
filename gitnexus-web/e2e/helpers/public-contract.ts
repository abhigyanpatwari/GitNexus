import { expect, type Page, type TestInfo } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
export const TOKEN_LEAK = 'ghs_secret_e2e_token';
export const MISSING_GITHUB = 'https://github.com/gitnexus-e2e-missing/no-such-repo';

const GALLERY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
const GITNEXUS_DIR = path.resolve(process.cwd(), '..', 'gitnexus');
const TSX_BIN = path.join(GITNEXUS_DIR, 'node_modules', '.bin', 'tsx');
const CLI_TS = path.join(GITNEXUS_DIR, 'src', 'cli', 'index.ts');
const CLI_DIST = path.join(GITNEXUS_DIR, 'dist', 'cli', 'index.js');
/** Per-request bound so a stalled connection cannot outlive a helper's deadline. */
const REQUEST_TIMEOUT_MS = 30_000;
/** POST /api/analyze allows 10/min per IP; 409 polling must not burn that budget. */
const SLOT_POLL_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LiveBackend {
  url: string;
  port: number;
  home: string;
  fixtures: string;
  child: ChildProcess;
  log: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('could not bind an ephemeral port'));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function serveArgs(port: number): { cmd: string; args: string[] } {
  if (fs.existsSync(TSX_BIN) && fs.existsSync(CLI_TS)) {
    return { cmd: TSX_BIN, args: [CLI_TS, 'serve', '--port', String(port), '--host', '127.0.0.1'] };
  }
  if (fs.existsSync(CLI_DIST)) {
    return {
      cmd: process.execPath,
      args: [CLI_DIST, 'serve', '--port', String(port), '--host', '127.0.0.1'],
    };
  }
  throw new Error(`neither ${TSX_BIN} nor ${CLI_DIST} is available`);
}

/** Spawn an isolated `gitnexus serve` on 127.0.0.1. */
export async function startLiveBackend(): Promise<LiveBackend> {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-e2e-home-'));
  const fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-e2e-fx-')));
  const { cmd, args } = serveArgs(port);
  const child = spawn(cmd, args, {
    cwd: GITNEXUS_DIR,
    env: {
      ...process.env,
      GITNEXUS_HOME: home,
      // Real parse workers — same override the CLI integration suite uses on
      // a loaded host. A 5s default ready budget dies when two live specs
      // cold-start worker pools at once.
      GITNEXUS_WORKER_READY_TIMEOUT_MS: process.env.GITNEXUS_WORKER_READY_TIMEOUT_MS ?? '60000',
      // Still a real pool; size 1 matches a two-file fixture and keeps two
      // parallel live servers from spawning cores-1 workers each.
      GITNEXUS_WORKER_POOL_SIZE: process.env.GITNEXUS_WORKER_POOL_SIZE ?? '1',
      // Serve forks analyze with min(8192, 0.75×RAM) MB. Two parallel specs
      // both getting an 8GB child is what produced `Worker crashed (code null)`.
      GITNEXUS_SERVER_ANALYZE_HEAP_MB: process.env.GITNEXUS_SERVER_ANALYZE_HEAP_MB ?? '512',
      GITNEXUS_WORKER_HEAP_MB: process.env.GITNEXUS_WORKER_HEAP_MB ?? '256',
      // Ladybug FTS CREATE_FTS_INDEX SIGSEGVs on this host (CLI exit 139).
      // Graph analyze still runs for real; keyword indexes are the only skip.
      GITNEXUS_SKIP_FTS: process.env.GITNEXUS_SKIP_FTS ?? '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so teardown also reaches the forked analyze worker.
    detached: process.platform !== 'win32',
  });
  const backend: LiveBackend = {
    url: `http://127.0.0.1:${port}`,
    port,
    home,
    fixtures,
    child,
    log: '',
  };
  const captureLog = (chunk: Buffer) => {
    backend.log = (backend.log + chunk.toString()).slice(-8_192);
  };
  child.stdout?.on('data', captureLog);
  child.stderr?.on('data', captureLog);

  let exited: number | null | undefined;
  child.on('exit', (code) => {
    exited = code;
  });

  const deadline = Date.now() + 45_000;
  try {
    for (;;) {
      if (exited !== undefined) {
        throw new Error(`live backend exited early (code ${exited}):\n${backend.log}`);
      }
      const ok = await fetch(`${backend.url}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) return backend;
      if (Date.now() > deadline) {
        throw new Error(`live backend did not become ready on ${backend.url}:\n${backend.log}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (err) {
    await stopLiveBackend(backend);
    throw err;
  }
}

export async function stopLiveBackend(backend: LiveBackend | undefined): Promise<void> {
  if (!backend) return;
  if (backend.child.exitCode === null && backend.child.signalCode === null) {
    const exited = new Promise<void>((resolve) => backend.child.once('exit', () => resolve()));
    const pid = backend.child.pid;
    const signal = (sig: NodeJS.Signals) => {
      if (pid !== undefined && process.platform !== 'win32') {
        try {
          process.kill(-pid, sig);
          return;
        } catch {
          /* group gone or not a leader: fall back to the child */
        }
      }
      backend.child.kill(sig);
    };
    signal('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exitedInTime = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 5_000);
        }),
      ]);
      if (!exitedInTime) {
        signal('SIGKILL');
        await exited;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  try {
    fs.rmSync(backend.home, { recursive: true, force: true });
    fs.rmSync(backend.fixtures, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

export function writeTinyRepo(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const ready = true;\n');
  const git = spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
  if (git.status === 0) {
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'e2e@gitnexus.test'], { stdio: 'ignore' });
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'e2e'], { stdio: 'ignore' });
    spawnSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    spawnSync('git', ['-C', dir, 'commit', '-qm', 'init'], { stdio: 'ignore' });
  }
  return dir;
}

export interface AnalyzePostResult {
  jobId: string;
  status?: string;
  error?: string;
  http: number;
  /** From the draft-7 `RateLimit` header; Infinity when absent. */
  remaining: number;
  resetMs: number;
}

/**
 * POST /api/analyze; a 429 waits out the limiter window and retries, unless
 * that wait would pass the caller's `deadline`.
 */
export async function postAnalyze(
  backendUrl: string,
  body: Record<string, unknown>,
  deadline = Infinity,
): Promise<AnalyzePostResult> {
  for (;;) {
    const res = await fetch(`${backendUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const rateLimit = res.headers.get('ratelimit') ?? '';
    const resetMs = Number(/reset=(\d+)/.exec(rateLimit)?.[1] ?? 60) * 1000;
    if (res.status === 429) {
      await res.body?.cancel();
      if (Date.now() + resetMs > deadline) {
        throw new Error('analyze rate limit outlasts the caller deadline (HTTP 429)');
      }
      await sleep(resetMs + 250);
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as {
      jobId?: string;
      status?: string;
      error?: string;
    };
    const remaining = /remaining=(\d+)/.exec(rateLimit)?.[1];
    return {
      jobId: json.jobId ?? '',
      status: json.status,
      error: json.error,
      http: res.status,
      remaining: remaining === undefined ? Infinity : Number(remaining),
      resetMs,
    };
  }
}

/**
 * Wait until the server will accept a new analyze, with at least `budget`
 * POST /api/analyze calls left in the rate-limit window so the caller's own
 * posts are not answered with 429.
 *
 * Probes with a clone that fails in-server before any worker fork: a `failed`
 * probe leaves no child holding the slot. A local-path probe would fork a
 * worker that outlives its own `failed` status and re-occupy the slot.
 */
export async function waitForAnalyzeSlotFree(
  backendUrl: string,
  timeoutMs = 90_000,
  budget = 3,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await postAnalyze(backendUrl, { url: MISSING_GITHUB }, deadline);
    if (probe.http !== 409) {
      if (probe.jobId) {
        await waitForJob(backendUrl, probe.jobId, Math.max(0, deadline - Date.now()));
      }
      if (probe.remaining < budget) await sleep(probe.resetMs + 250);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`analyze slot stayed busy: ${probe.error ?? 'HTTP 409'}`);
    }
    await sleep(SLOT_POLL_MS);
  }
}

/** Single-slot: a failed job still occupies the slot until its child exits. */
export async function postAnalyzeWhenIdle(
  backendUrl: string,
  body: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<AnalyzePostResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await postAnalyze(backendUrl, body, deadline);
    if (result.http !== 409) return result;
    if (Date.now() > deadline) {
      throw new Error(`analyze slot stayed busy: ${result.error ?? 'HTTP 409'}`);
    }
    await sleep(SLOT_POLL_MS);
  }
}

export async function waitForJob(
  backendUrl: string,
  jobId: string,
  timeoutMs = 120_000,
): Promise<{ status: string; error?: string; repoName?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const poll = await fetch(`${backendUrl}/api/analyze/${jobId}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const job = (await poll.json()) as { status: string; error?: string; repoName?: string };
    if (job.status === 'complete' || job.status === 'failed') {
      return job;
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} timed out at ${job.status}`);
    await sleep(400);
  }
}

export async function fetchOps(backendUrl: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${backendUrl}/api/ops`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET /api/ops → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Point the app at this spec's live server before the first navigation. */
export async function bindBackend(page: Page, backendUrl: string): Promise<void> {
  await page.addInitScript((url) => {
    window.localStorage.setItem('gitnexus-backend-url', url);
  }, backendUrl);
}

function frontendHref(base: string, pathAndQuery: string): string {
  const normalized = base.endsWith('/') ? base : `${base}/`;
  return new URL(pathAndQuery.replace(/^\//, ''), normalized).href;
}

const probeFrontend = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(2_000) })
    .then((r) => r.ok)
    .catch(() => false);

/** Prefer an explicit FRONTEND_URL; otherwise the first listener CI or local Vite bound. */
async function resolveFrontendUrl(): Promise<string> {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL;
  for (const url of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
    if (await probeFrontend(url)) return url;
  }
  return FRONTEND_URL;
}

export async function openAnalyzeForm(page: Page): Promise<void> {
  // Stay on the reachable frontend (localStorage already has the backend).
  // `?server=` makes App auto-load the last graph and never show the form.
  // DropZone on `/` shows onboarding (0 repos) or landing + analyze (N repos).
  await page.goto(frontendHref(await resolveFrontendUrl(), '/'));
  await expect(page.getByRole('tab', { name: 'GitHub URL' })).toBeVisible({ timeout: 30_000 });
}

export async function openOps(page: Page, backendUrl: string): Promise<void> {
  await page.goto(
    frontendHref(await resolveFrontendUrl(), `/?view=ops&server=${encodeURIComponent(backendUrl)}`),
  );
  await expect(page.locator('[data-testid="ops-dashboard"]')).toBeVisible({ timeout: 20_000 });
}

/** Empty string means go; otherwise a skip reason (or throw under E2E=1). */
export async function livePrereqSkipReason(): Promise<string> {
  const frontendUp =
    (await probeFrontend(FRONTEND_URL)) ||
    (await probeFrontend('http://localhost:5173')) ||
    (await probeFrontend('http://127.0.0.1:5173'));
  const cliReady = fs.existsSync(TSX_BIN) || fs.existsSync(CLI_DIST);
  if (process.env.E2E) {
    if (!cliReady) throw new Error(`backend CLI missing (${CLI_TS} / ${CLI_DIST})`);
    if (!frontendUp) throw new Error(`Vite dev server not available at ${FRONTEND_URL}`);
    return '';
  }
  if (!frontendUp) return 'Vite dev server not available';
  if (!cliReady) return 'backend CLI not available';
  return '';
}

export async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const out = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: out, fullPage: true });
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
  const slug = testInfo.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72);
  fs.copyFileSync(out, path.join(GALLERY_DIR, `${slug}--${name}.png`));
}

export async function assertNoLeaks(page: Page, extra: string[] = []): Promise<void> {
  const body = await page.locator('body').innerText();
  for (const leak of [TOKEN_LEAK, 'ghs_secret', 'x-access-token', ...extra]) {
    expect(body, `page must not show ${leak}`).not.toContain(leak);
  }
  expect(body).not.toMatch(/[A-Za-z]:\\Users\\/);
}
