import { test, expect, type Page } from '@playwright/test';
import {
  BACKEND_URL,
  CLONE_LEAK,
  HOME_LEAK,
  TOKEN_LEAK,
  WIN_LEAK,
  assertNoLeaks,
  capture,
  emptyMetrics,
  mockIdleBackend,
} from './helpers/public-contract';

/**
 * User-case e2e for `?view=ops` (Execution Ops).
 *
 * The dashboard is unauthenticated, so every painted string must stay on the
 * public contract: basename + redacted progress/error. Screenshots land in
 * test-results and e2e/screenshots/.
 */

const publicSnapshot = {
  generatedAt: 1_700_000_000_000,
  uptimeMs: 12_000,
  health: 'ok' as const,
  server: { version: '1.6.11', launchContext: 'local', nodeVersion: 'v22.0.0' },
  analyze: {
    jobs: [
      {
        id: 'job-analyze-1',
        lane: 'analyze' as const,
        status: 'failed' as const,
        repoName: 'private-repo',
        retryCount: 0,
        durationMs: 4_000,
        startedAt: 1_700_000_000_000,
        progress: {
          phase: 'cloning',
          percent: 0,
          message: 'Cloning [repo]...',
        },
        error: 'Existing clone at [path] has no remote.origin',
      },
    ],
    metrics: { ...emptyMetrics, total: 1, failed: 1 },
  },
  embed: {
    jobs: [
      {
        id: 'job-embed-1',
        lane: 'embed' as const,
        status: 'analyzing' as const,
        repoName: 'private-repo',
        retryCount: 0,
        durationMs: 2_000,
        startedAt: 1_700_000_001_000,
        progress: {
          phase: 'embedding',
          percent: 40,
          message: 'Embedding nodes',
        },
      },
    ],
    metrics: { ...emptyMetrics, total: 1, active: 1 },
  },
  totals: { jobs: 2, active: 1, failed: 1, complete: 0 },
};

const emptySnapshot = {
  generatedAt: 1_700_000_000_000,
  uptimeMs: 5_000,
  health: 'ok' as const,
  server: { version: '1.6.11', launchContext: 'local', nodeVersion: 'v22.0.0' },
  analyze: { jobs: [] as typeof publicSnapshot.analyze.jobs, metrics: { ...emptyMetrics } },
  embed: { jobs: [] as typeof publicSnapshot.embed.jobs, metrics: { ...emptyMetrics } },
  totals: { jobs: 0, active: 0, failed: 0, complete: 0 },
};

async function mockOps(page: Page, snapshot: unknown) {
  await mockIdleBackend(page);
  await page.route(`${BACKEND_URL}/api/ops`, (route) => route.fulfill({ json: snapshot }));
  await page.route(`${BACKEND_URL}/api/ops/stream`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: `data: ${JSON.stringify(snapshot)}\n\n`,
    }),
  );
}

async function openOps(page: Page) {
  await page.goto('/?view=ops');
  await expect(page.locator('[data-testid="ops-dashboard"]')).toBeVisible({ timeout: 15_000 });
}

test.describe('Ops dashboard — live public jobs', () => {
  test.beforeEach(async ({ page }) => {
    await mockOps(page, publicSnapshot);
  });

  test('renders lanes, metrics, and recent activity without secrets', async ({
    page,
  }, testInfo) => {
    await openOps(page);
    await expect(page.getByRole('heading', { name: 'Execution Ops' })).toBeVisible();
    await expect(page.getByText(/live · (sse|poll)/)).toBeVisible();
    await capture(page, testInfo, '01-live-jobs');

    await expect(page.getByText('Analyze lane')).toBeVisible();
    await expect(page.getByText('0 active · 0 queued · 0 done · 1 failed')).toBeVisible();
    await expect(page.getByText('Embed lane')).toBeVisible();
    await expect(page.getByText('1 active · 0 queued · 0 done · 0 failed')).toBeVisible();

    await expect(page.getByText('Active jobs')).toBeVisible();
    await expect(page.getByText('Completed')).toBeVisible();
    await expect(page.getByText('Failed', { exact: true })).toBeVisible();
    await expect(page.getByText('1.6.11')).toBeVisible();
    await expect(page.getByText('local · v22.0.0')).toBeVisible();

    const analyzeJob = page.locator('[data-testid="ops-job"][data-job-id="job-analyze-1"]');
    await expect(analyzeJob).toBeVisible();
    await expect(analyzeJob.getByText('private-repo')).toBeVisible();
    await expect(analyzeJob.getByText('failed', { exact: true })).toBeVisible();
    await expect(analyzeJob.getByText('Cloning [repo]...')).toBeVisible();
    await expect(
      analyzeJob.getByText('Existing clone at [path] has no remote.origin'),
    ).toBeVisible();

    const embedJob = page.locator('[data-testid="ops-job"][data-job-id="job-embed-1"]');
    await expect(embedJob).toBeVisible();
    await expect(embedJob.getByText('40%')).toBeVisible();
    await expect(embedJob.getByText('Embedding nodes')).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(2);
    // Newest first: embed started later than analyze.
    await expect(rows.nth(0)).toContainText('embed');
    await expect(rows.nth(0)).toContainText('private-repo');
    await expect(rows.nth(1)).toContainText('analyze');
    await expect(rows.nth(1)).toContainText('failed');

    await assertNoLeaks(page, ['/home/', 'alice', 'github.com/user']);
  });

  test('mobile viewport still shows public rows only', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openOps(page);
    await expect(
      page.locator('[data-testid="ops-job"][data-job-id="job-analyze-1"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="ops-job"][data-job-id="job-embed-1"]')).toBeVisible();
    await capture(page, testInfo, '02-mobile');
    await assertNoLeaks(page, ['/home/', 'alice']);
  });
});

test.describe('Ops dashboard — empty and connection states', () => {
  test('empty server shows vacant lanes and waiting table', async ({ page }, testInfo) => {
    await mockOps(page, emptySnapshot);
    await openOps(page);
    await expect(page.getByText('No jobs in this lane yet')).toHaveCount(2);
    await expect(
      page.getByText('Waiting for analyze / embed jobs on the connected server…'),
    ).toBeVisible();
    await expect(page.getByText('0 active · 0 queued · 0 done · 0 failed')).toHaveCount(2);
    await capture(page, testInfo, '03-empty');
    await assertNoLeaks(page);
  });

  test('unreachable backend shows offline and a connect error', async ({ page }, testInfo) => {
    await mockIdleBackend(page);
    await page.route(`${BACKEND_URL}/api/health`, (route) => route.abort('connectionrefused'));
    await page.goto('/?view=ops');
    await expect(page.locator('[data-testid="ops-dashboard"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/offline/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Backend unreachable')).toBeVisible();
    await capture(page, testInfo, '04-unreachable');
  });

  test('gated backend tells the operator it needs auth', async ({ page }, testInfo) => {
    await mockIdleBackend(page);
    await page.route(`${BACKEND_URL}/api/health`, (route) => route.fulfill({ status: 401 }));
    await page.goto('/?view=ops');
    await expect(page.locator('[data-testid="ops-dashboard"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Backend requires auth')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/offline/)).toBeVisible();
    await capture(page, testInfo, '05-unauthorized');
  });

  test('Connect to a dead server updates the URL and goes offline', async ({ page }, testInfo) => {
    await mockOps(page, publicSnapshot);
    await openOps(page);
    await expect(page.getByText(/live · (sse|poll)/)).toBeVisible();
    await capture(page, testInfo, '06-before-reconnect');

    const serverInput = page.locator('input[placeholder="http://localhost:4747"]');
    await serverInput.fill('http://127.0.0.1:5999');
    await page.getByRole('button', { name: 'Connect' }).click();

    await expect(page.getByText('Backend unreachable')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/offline/)).toBeVisible();
    expect(decodeURIComponent(page.url())).toContain('127.0.0.1:5999');
    expect(page.url()).toContain('view=ops');
    await capture(page, testInfo, '07-after-dead-connect');
  });
});

test.describe('Ops dashboard — public payload hygiene', () => {
  test('extra path/clone/token fields on a job are not painted', async ({ page }, testInfo) => {
    const leaky = structuredClone(publicSnapshot);
    Object.assign(leaky.analyze.jobs[0], {
      repoPath: HOME_LEAK,
      cloneUrl: CLONE_LEAK,
      token: TOKEN_LEAK,
      path: WIN_LEAK,
    });
    await mockOps(page, leaky);
    await openOps(page);
    await expect(
      page.locator('[data-testid="ops-job"][data-job-id="job-analyze-1"]'),
    ).toBeVisible();
    await expect(page.getByText('private-repo').first()).toBeVisible();
    await capture(page, testInfo, '08-leaky-payload-not-rendered');
    await assertNoLeaks(page, ['/home/', 'alice', 'github.com/user']);
  });

  test('missing repoName falls back to the job id prefix; retry and branch show', async ({
    page,
  }, testInfo) => {
    const snapshot = {
      ...emptySnapshot,
      analyze: {
        jobs: [
          {
            id: 'job-abcdef012345',
            lane: 'analyze' as const,
            status: 'analyzing' as const,
            retryCount: 2,
            branch: 'release/1.6',
            durationMs: 90_000,
            startedAt: 1_700_000_002_000,
            progress: { phase: 'parsing', percent: 55, message: 'Parsing code' },
          },
        ],
        metrics: { ...emptyMetrics, total: 1, active: 1 },
      },
      totals: { jobs: 1, active: 1, failed: 0, complete: 0 },
    };
    await mockOps(page, snapshot);
    await openOps(page);

    const job = page.locator('[data-testid="ops-job"][data-job-id="job-abcdef012345"]');
    await expect(job).toBeVisible();
    await expect(job.getByText('job-abcd', { exact: true })).toBeVisible();
    await expect(job.getByText(/retry 2/)).toBeVisible();
    await expect(job.getByText(/release\/1\.6/)).toBeVisible();
    await expect(job.getByText('55%')).toBeVisible();
    await capture(page, testInfo, '09-id-fallback-retry-branch');
    await assertNoLeaks(page);
  });
});
