import { test, expect } from '@playwright/test';
import {
  MISSING_GITHUB,
  assertNoLeaks,
  bindBackend,
  capture,
  fetchOps,
  livePrereqSkipReason,
  openOps,
  postAnalyze,
  postAnalyzeWhenIdle,
  startLiveBackend,
  stopLiveBackend,
  waitForJob,
  writeTinyRepo,
  type LiveBackend,
} from './helpers/public-contract';

/**
 * Live e2e for `?view=ops`. Spawns a real `gitnexus serve` and reads the
 * unauthenticated ops feed the server actually emits — no `page.route` mocks.
 */

test.describe.configure({ mode: 'serial' });

let backend: LiveBackend | undefined;
let completeName = '';
let completePath = '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const skip = await livePrereqSkipReason();
  if (skip) {
    test.skip(true, skip);
    return;
  }
  backend = await startLiveBackend();
});

test.beforeEach(async ({ page }) => {
  if (!backend) return;
  await bindBackend(page, backend.url);
});

test.afterAll(async () => {
  await stopLiveBackend(backend);
});

function requireBackend(): LiveBackend {
  if (!backend) throw new Error('live backend was not started');
  return backend;
}

test.describe('Ops dashboard — empty and connection states', () => {
  test('empty server shows vacant lanes and waiting table', async ({ page }, testInfo) => {
    const { url } = requireBackend();
    await openOps(page, url);
    await expect(page.getByText('No jobs in this lane yet')).toHaveCount(2);
    await expect(
      page.getByText('Waiting for analyze / embed jobs on the connected server…'),
    ).toBeVisible();
    await expect(page.getByText('0 active · 0 queued · 0 done · 0 failed')).toHaveCount(2);
    await capture(page, testInfo, '03-empty');
    await assertNoLeaks(page);
  });

  test('unreachable backend shows offline and a connect error', async ({ page }, testInfo) => {
    await openOps(page, 'http://127.0.0.1:5999');
    await expect(page.getByText(/offline/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Backend unreachable')).toBeVisible();
    await capture(page, testInfo, '04-unreachable');
  });

  test('Connect to a dead server updates the URL and goes offline', async ({ page }, testInfo) => {
    const { url } = requireBackend();
    await openOps(page, url);
    await expect(page.getByText(/live · (sse|poll)/)).toBeVisible({ timeout: 15_000 });
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

test.describe('Ops dashboard — live public jobs', () => {
  test('renders a real failed + complete analyze without leaking the repo path', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const { url, fixtures } = requireBackend();
    completeName = 'private-repo';
    completePath = writeTinyRepo(fixtures, completeName);

    const fail = await postAnalyze(url, { url: MISSING_GITHUB });
    if (fail.jobId) await waitForJob(url, fail.jobId);
    const ok = await postAnalyzeWhenIdle(url, { path: completePath });
    expect(ok.http).toBeLessThan(400);
    const done = await waitForJob(url, ok.jobId);
    expect(done.status, done.error).toMatch(/complete/);

    const snap = await fetchOps(url);
    const raw = JSON.stringify(snap);
    expect(raw).not.toContain(completePath);
    expect(raw).not.toContain(fixtures);
    expect(raw).not.toContain('"repoPath"');
    expect(raw).not.toContain('"repoUrl"');
    expect(raw).not.toContain('"branch"');

    await openOps(page, url);
    await expect(page.getByRole('heading', { name: 'Execution Ops' })).toBeVisible();
    await expect(page.getByText(/live · (sse|poll)/)).toBeVisible();
    await capture(page, testInfo, '01-live-jobs');

    await expect(page.getByText('Analyze lane')).toBeVisible();
    await expect(page.getByText(/1 failed/)).toBeVisible();
    await expect(page.getByText(/1 done/)).toBeVisible();

    const jobs = page.locator('[data-testid="ops-job"]');
    await expect(jobs).toHaveCount(2);
    await expect(page.getByText(completeName).first()).toBeVisible();
    await expect(page.getByText('failed', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('complete', { exact: true }).first()).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
    await expect(page.locator('table tbody tr')).toHaveCount(2);

    await capture(page, testInfo, '01b-live-jobs-detail');
    await assertNoLeaks(page, [fixtures, completePath]);
  });

  test('mobile viewport still shows public rows only', async ({ page }, testInfo) => {
    const { url, fixtures } = requireBackend();
    await page.setViewportSize({ width: 390, height: 844 });
    await openOps(page, url);
    await expect(page.locator('[data-testid="ops-job"]').first()).toBeVisible();
    await capture(page, testInfo, '02-mobile');
    await assertNoLeaks(page, [fixtures]);
  });
});
