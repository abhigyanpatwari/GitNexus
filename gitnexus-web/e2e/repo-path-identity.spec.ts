import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * E2E tests for repo *path* identity with duplicate display names (#2419).
 *
 * Unlike the sibling specs, this file runs WRITE operations (analyze,
 * re-analyze, delete), so it spawns its OWN backend on a dedicated port with
 * an isolated GITNEXUS_HOME instead of sharing the suite-wide server: a force
 * re-analysis rewrites LadybugDB files under a live server, and doing that on
 * the shared instance while parallel workers hold connections has taken the
 * whole backend down in CI (every later test in every file died with
 * ECONNRESET). Isolation also makes the registry hermetic — exactly the two
 * duplicates exist, and nothing here can perturb the other suites.
 *
 * Two repos with the SAME basename (`pr2419-dupe`) under different parent
 * directories are provisioned against that backend via POST /api/analyze.
 * Each contains a uniquely named marker file so the tests can assert which
 * repo's graph is actually on screen — the whole point of #2419 is that name
 * alone cannot distinguish them.
 *
 * Covers each ambiguity from the issue's "Actual behavior" list, end to end
 * through a real browser:
 *  - duplicate rows render, and the ACTIVE one is identifiable (active-state
 *    comparison must not use `repo.name === projectName`)
 *  - switching between duplicates swaps the loaded graph (switching must not
 *    pass `repo.name` into onSwitchRepo)
 *  - re-analyze targets the clicked duplicate's exact path, tracks progress
 *    on that row only, and reconnects to that same duplicate on completion
 *  - delete removes exactly the chosen duplicate, not its sibling
 *  - backend HTTP repo resolution treats ?repo= as a path: landing selection
 *    loads the exact repo, ?repo= survives F5, and a stale path fails closed
 *    to the repo picker instead of silently retargeting the sibling
 */

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

// Spec-owned backend (spawned in beforeAll) — deliberately NOT the shared
// suite server; see the header comment. 127.0.0.1 (not localhost) because the
// availability probes here run in Node, whose fetch resolves localhost to an
// address the server may not be bound to.
const BACKEND_PORT = 4799;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
// Playwright's cwd is gitnexus-web (the config dir).
const CLI_PATH = path.resolve(process.cwd(), '..', 'gitnexus', 'dist', 'cli', 'index.js');

const DUPE_NAME = 'pr2419-dupe';
const READY_TIMEOUT_MS = 45_000;

interface AnalyzeJobResponse {
  jobId: string;
}
interface AnalyzeJobStatus {
  status: string;
  error?: string;
}
interface RepoListEntry {
  name: string;
  repoPath?: string;
  path?: string;
}

let tempRoot = '';
let gitnexusHome = '';
let server: ChildProcess | undefined;
let serverLog = '';
let serverExited: number | null | undefined;
/** Duplicate repo paths in registry (= card/switcher-row) order. */
let dupePaths: string[] = [];

/** Spawn the spec-owned backend and wait until it serves /api/repos. */
async function startBackend(): Promise<void> {
  gitnexusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-dupe-home-'));
  server = spawn(
    process.execPath,
    [CLI_PATH, 'serve', '--port', String(BACKEND_PORT), '--host', '127.0.0.1'],
    {
      env: { ...process.env, GITNEXUS_HOME: gitnexusHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const capture = (chunk: Buffer) => {
    serverLog = (serverLog + chunk.toString()).slice(-8_192);
  };
  server.stdout?.on('data', capture);
  server.stderr?.on('data', capture);
  server.on('exit', (code) => {
    serverExited = code;
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (serverExited !== undefined) {
      throw new Error(`spec backend exited early (code ${serverExited}):\n${serverLog}`);
    }
    const ok = await fetch(`${BACKEND_URL}/api/repos`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    if (Date.now() > deadline) {
      throw new Error(`spec backend did not become ready on ${BACKEND_URL}:\n${serverLog}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The marker file proving which duplicate's graph is on screen. Keyed off the
 * team-a/team-b path segment (not exact path equality) so macOS
 * `/var` → `/private/var` realpath drift can't break the mapping.
 */
function markerFile(repoPath: string): string {
  return repoPath.includes(`${path.sep}team-a${path.sep}`)
    ? 'team-a-marker.ts'
    : 'team-b-marker.ts';
}

async function analyzeAndWait(repoPath: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: repoPath, force: true }),
  });
  if (!res.ok) throw new Error(`POST /api/analyze for ${repoPath} → HTTP ${res.status}`);
  const { jobId } = (await res.json()) as AnalyzeJobResponse;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const poll = await fetch(`${BACKEND_URL}/api/analyze/${jobId}`);
    const job = (await poll.json()) as AnalyzeJobStatus;
    if (job.status === 'complete' || job.status === 'completed') return;
    if (job.status === 'failed') throw new Error(`analyze ${repoPath} failed: ${job.error}`);
    if (Date.now() > deadline) throw new Error(`analyze ${repoPath} timed out`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

async function deleteRepoByPath(repoPath: string): Promise<void> {
  await fetch(`${BACKEND_URL}/api/repo?repo=${encodeURIComponent(repoPath)}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}

async function listDupes(): Promise<string[]> {
  const res = await fetch(`${BACKEND_URL}/api/repos`);
  const repos = (await res.json()) as RepoListEntry[];
  return repos.filter((r) => r.name === DUPE_NAME).map((r) => r.repoPath ?? r.path ?? '');
}

test.beforeAll(async () => {
  // Backend spawn + two sequential live analyses can exceed the default budget.
  test.setTimeout(300_000);

  // Local runs skip gracefully when prerequisites are missing; under E2E=1
  // (CI) a missing prerequisite is an infra failure and must fail loudly.
  if (!process.env.E2E) {
    const frontendUp = await fetch(FRONTEND_URL)
      .then((r) => r.ok)
      .catch(() => false);
    if (!frontendUp) {
      test.skip(true, 'Vite dev server not available');
      return;
    }
    if (!fs.existsSync(CLI_PATH)) {
      test.skip(true, `backend CLI not built (${CLI_PATH})`);
      return;
    }
  }

  await startBackend();

  // Provision two repos with the SAME basename under different parents.
  // The registry (fresh GITNEXUS_HOME) is hermetic by construction.
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-dupe-e2e-')));
  const pathA = path.join(tempRoot, 'team-a', DUPE_NAME);
  const pathB = path.join(tempRoot, 'team-b', DUPE_NAME);
  fs.mkdirSync(pathA, { recursive: true });
  fs.mkdirSync(pathB, { recursive: true });
  fs.writeFileSync(
    path.join(pathA, 'team-a-marker.ts'),
    'export function teamAOnly(): string {\n  return "team-a";\n}\n',
  );
  fs.writeFileSync(
    path.join(pathB, 'team-b-marker.ts'),
    'export function teamBOnly(): string {\n  return "team-b";\n}\n',
  );

  // Sequential on purpose — concurrent analyses contend for the repo lock.
  await analyzeAndWait(pathA);
  await analyzeAndWait(pathB);

  dupePaths = await listDupes();
  if (dupePaths.length !== 2) {
    throw new Error(`expected 2 registered "${DUPE_NAME}" repos, got ${dupePaths.length}`);
  }
});

// Every page in this file must talk to the spec-owned backend: both the
// probe-driven landing flow and the ?server= auto-connect read the backend
// URL from useBackend, which honors this supported localStorage override.
test.beforeEach(async ({ page }) => {
  await page.addInitScript((backendUrl) => {
    window.localStorage.setItem('gitnexus-backend-url', backendUrl);
  }, BACKEND_URL);
});

test.afterAll(async () => {
  if (server && serverExited !== undefined) {
    // The backend crashed mid-run — surface its output, which CI otherwise loses.
    console.error(`spec backend exited (code ${serverExited}); last output:\n${serverLog}`);
  }
  if (server && serverExited === undefined) {
    // Wait for the process to actually exit before removing its storage,
    // otherwise the rm races the server's final writes.
    const exited = new Promise<void>((resolve) => server?.once('exit', () => resolve()));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  }
  try {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    if (gitnexusHome) fs.rmSync(gitnexusHome, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of temp dirs */
  }
});

/** Loads a specific duplicate directly via URL params and waits for Ready. */
async function connectTo(page: Page, repoPath: string): Promise<void> {
  await page.goto(
    `/?server=${encodeURIComponent(BACKEND_URL)}&project=${encodeURIComponent(DUPE_NAME)}&repo=${encodeURIComponent(repoPath)}`,
  );
  await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({
    timeout: READY_TIMEOUT_MS,
  });
}

/** The explorer file entry proving which duplicate's graph is on screen. */
function marker(page: Page, repoPath: string) {
  return page.getByText(markerFile(repoPath)).first();
}

// ── 1. Landing selection targets the exact path, not the first name match ────

test('landing lists both duplicates and selecting the second loads its exact path', async ({
  page,
}) => {
  // Plain `/` (no ?server= — that param auto-connects and skips the landing);
  // the beforeEach localStorage override points the probe at the spec backend.
  await page.goto('/');

  const dupeCards = page
    .locator('[data-testid="landing-repo-card"]')
    .filter({ hasText: DUPE_NAME });
  await expect(dupeCards).toHaveCount(2, { timeout: 20_000 });

  // The second card is the second registry entry — the repo a name-keyed
  // lookup would NEVER reach (it always resolves the first match, #2419).
  await dupeCards.nth(1).click();
  await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({
    timeout: READY_TIMEOUT_MS,
  });

  const url = new URL(page.url());
  expect(url.searchParams.get('repo')).toBe(dupePaths[1]);
  expect(url.searchParams.get('project')).toBe(DUPE_NAME);

  await expect(marker(page, dupePaths[1])).toBeVisible();
  await expect(marker(page, dupePaths[0])).toBeHidden();
});

// ── 2. Header switcher swaps between same-named repos by path ────────────────

test('header switcher switches between duplicates and swaps the loaded graph', async ({ page }) => {
  await connectTo(page, dupePaths[0]);
  await expect(marker(page, dupePaths[0])).toBeVisible();

  await page.locator('[data-testid="repo-switcher-trigger"]').click();

  const rows = page.locator('[data-testid="repo-switcher-row"]').filter({ hasText: DUPE_NAME });
  await expect(rows).toHaveCount(2);

  // Issue step 4: "Try to identify the active repository" — exactly one
  // duplicate is marked active, and it is the one the URL points at
  // (rows render in registry order, so row 0 ↔ dupePaths[0]).
  await expect(rows.nth(0)).toHaveAttribute('data-active', 'true');
  await expect(rows.nth(1)).toHaveAttribute('data-active', 'false');

  const inactiveRow = page
    .locator('[data-testid="repo-switcher-row"][data-active="false"]')
    .filter({ hasText: DUPE_NAME });
  await inactiveRow.locator('button').first().click();

  await page.waitForURL((u) => u.searchParams.get('repo') === dupePaths[1], {
    timeout: READY_TIMEOUT_MS,
  });
  await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({
    timeout: READY_TIMEOUT_MS,
  });
  await expect(marker(page, dupePaths[1])).toBeVisible();
  await expect(marker(page, dupePaths[0])).toBeHidden();

  // Re-open the switcher: the active marker must have followed the switch.
  await page.locator('[data-testid="repo-switcher-trigger"]').click();
  await expect(rows.nth(0)).toHaveAttribute('data-active', 'false');
  await expect(rows.nth(1)).toHaveAttribute('data-active', 'true');
});

// ── 3. ?repo= path identity survives reload ──────────────────────────────────

test('?repo= path identity survives F5 reload', async ({ page }) => {
  test.slow(); // two sequential connects (initial + reload)

  await connectTo(page, dupePaths[1]);

  await page.reload();
  await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({
    timeout: READY_TIMEOUT_MS,
  });

  const url = new URL(page.url());
  expect(url.searchParams.get('repo')).toBe(dupePaths[1]);
  await expect(marker(page, dupePaths[1])).toBeVisible();
});

// ── 4. Stale ?repo= fails closed instead of retargeting the sibling ──────────

test('stale ?repo= path falls back to the repo picker, never a same-named sibling', async ({
  page,
}) => {
  const stalePath = path.join(tempRoot, 'ghost', DUPE_NAME);
  await page.goto(
    `/?server=${encodeURIComponent(BACKEND_URL)}&project=${encodeURIComponent(DUPE_NAME)}&repo=${encodeURIComponent(stalePath)}`,
  );

  // Fail-closed: the app must not silently load whichever sibling matches by
  // name. The exact recovery surface can be either the error/onboarding path or
  // the repo picker while the server probe settles, so assert the identity
  // contract instead of overfitting the transient UI phase.
  await expect(page.locator('[data-testid="status-ready"]')).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(marker(page, dupePaths[0])).toHaveCount(0);
  await expect(marker(page, dupePaths[1])).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('repo')).toBe(stalePath);
});

// ── 5. Re-analyze targets the exact duplicate, not whatever matches by name ──

test('re-analyzing a duplicate targets its exact path throughout the flow', async ({ page }) => {
  // Live re-index can exceed the default budget.
  test.setTimeout(240_000);

  await connectTo(page, dupePaths[0]);

  // Track which repo every subsequent connect-shaped request targets. Attached
  // while the app idles on dupePaths[0], so everything recorded from here on
  // is driven by the re-analyze flow.
  const connectTargets: string[] = [];
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/api/repo' || u.pathname === '/api/graph') {
      const target = u.searchParams.get('repo');
      if (target) connectTargets.push(target);
    }
  });

  await page.locator('[data-testid="repo-switcher-trigger"]').click();
  const activeRow = page
    .locator('[data-testid="repo-switcher-row"][data-active="true"]')
    .filter({ hasText: DUPE_NAME });
  const inactiveRow = page
    .locator('[data-testid="repo-switcher-row"][data-active="false"]')
    .filter({ hasText: DUPE_NAME });
  await expect(inactiveRow).toHaveCount(1);

  // Re-analyze the INACTIVE duplicate — the repo a name-keyed flow would
  // confuse with its sibling at every step.
  const analyzeRequest = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().includes('/api/analyze'),
  );
  await inactiveRow.hover();
  await inactiveRow.locator('[data-testid="repo-switcher-reanalyze"]').click();

  // The analyze POST must carry the clicked duplicate's path.
  const analyzePost = await analyzeRequest;
  const body = analyzePost.postDataJSON() as { path?: string };
  expect(body.path).toBe(dupePaths[1]);
  const analyzeResponse = await analyzePost.response();
  if (!analyzeResponse) throw new Error('analyze POST received no response');
  if (!analyzeResponse.ok()) {
    throw new Error(`analyze POST failed with HTTP ${analyzeResponse.status()}`);
  }

  // Progress is tracked per path identity: only the clicked row spins. Under
  // name-keyed tracking (`reanalyzing === repo.name`) BOTH rows would spin.
  await expect(inactiveRow.locator('.animate-spin')).toHaveCount(1);
  await expect(activeRow.locator('.animate-spin')).toHaveCount(0);

  // On completion the app reconnects to the re-analyzed duplicate ITSELF — a
  // name-keyed completion would reconnect to the FIRST name match (the
  // sibling). Assert the identity of the reconnect at the request level.
  //
  // Deliberately NOT asserted here: that the reconnect reaches the Ready
  // state. A pre-existing storage race (any repo, duplicates or not) can
  // leave a freshly re-analyzed database transiently unreadable ("Binder
  // exception: Table CodeRelation does not exist") right after completion,
  // which would fail this test for reasons unrelated to the #2419 identity
  // contract it covers. Tighten to a full Ready assertion once that is fixed.
  await expect
    .poll(() => connectTargets.filter((t) => t === dupePaths[1]).length, { timeout: 120_000 })
    .toBeGreaterThan(0);
  expect(connectTargets).not.toContain(dupePaths[0]);

  // Re-analyze must not duplicate or replace registry entries.
  expect((await listDupes()).sort()).toEqual([...dupePaths].sort());
});

// ── 6. Delete removes exactly the chosen duplicate, not its sibling ──────────

test('deleting one duplicate leaves the same-named sibling registered and loaded', async ({
  page,
}) => {
  // Delete retries below may wait out a server-side repo lock.
  test.setTimeout(120_000);

  await connectTo(page, dupePaths[0]);

  // Record every DELETE the UI issues — the #2419 contract is that they all
  // target exactly the chosen duplicate's path and NEVER the sibling's.
  const deleteTargets: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'DELETE' && req.url().includes('/api/repo')) {
      const target = new URL(req.url()).searchParams.get('repo');
      if (target) deleteTargets.push(target);
    }
  });

  await page.locator('[data-testid="repo-switcher-trigger"]').click();
  const inactiveRow = page
    .locator('[data-testid="repo-switcher-row"][data-active="false"]')
    .filter({ hasText: DUPE_NAME });
  await expect(inactiveRow).toHaveCount(1);

  // Retry the whole click-and-verify block, because two pre-existing server
  // races (both unrelated to the #2419 identity contract) can make a single
  // click insufficient: a lingering analyze/embed job still holding the repo
  // lock 409s the delete, and the registry's validate-prune path can clobber
  // a concurrent unregister with its pre-delete snapshot, transiently
  // resurrecting the entry after the UI has already dropped the row (in that
  // case re-issue the delete by path, off-page, since the row is gone).
  await expect(async () => {
    if ((await inactiveRow.count()) > 0) {
      // Delete icon is revealed on row hover.
      await inactiveRow.hover();
      await inactiveRow.locator('[data-testid="repo-switcher-delete"]').click();
    } else if ((await listDupes()).includes(dupePaths[1])) {
      await deleteRepoByPath(dupePaths[1]);
    }
    // Backend: exactly the inactive sibling is gone, the active one remains.
    expect(await listDupes()).toEqual([dupePaths[0]]);
  }).toPass({ timeout: 90_000, intervals: [2_000] });

  // Identity: the UI's delete requests all targeted the chosen duplicate.
  expect(deleteTargets.length).toBeGreaterThan(0);
  expect([...new Set(deleteTargets)]).toEqual([dupePaths[1]]);

  // Frontend: the active repo is untouched — still Ready on the same path.
  await expect(page.locator('[data-testid="status-ready"]')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('repo')).toBe(dupePaths[0]);
});
