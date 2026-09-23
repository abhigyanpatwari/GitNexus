import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import {
  MISSING_GITHUB,
  TOKEN_LEAK,
  assertNoLeaks,
  bindBackend,
  capture,
  fetchOps,
  livePrereqSkipReason,
  openAnalyzeForm,
  postAnalyze,
  startLiveBackend,
  stopLiveBackend,
  waitForAnalyzeSlotFree,
  waitForJob,
  writeTinyRepo,
  type LiveBackend,
} from './helpers/public-contract';

/**
 * Live e2e for the public analyze flow. Spawns a real `gitnexus serve` and
 * drives the UI — no `page.route` mocks.
 */

test.describe.configure({ mode: 'serial' });

let backend: LiveBackend | undefined;

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

test.describe('Analyze — happy path', () => {
  test('local folder path → real analyze → done by basename, no path on screen', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const { url, fixtures } = requireBackend();
    const repoDir = writeTinyRepo(fixtures, 'courses');
    const repoQueries: string[] = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.pathname === '/api/repo' || u.pathname === '/api/graph') {
        const repo = u.searchParams.get('repo');
        if (repo) repoQueries.push(repo);
      }
    });

    await openAnalyzeForm(page);
    await capture(page, testInfo, '01-empty-form');

    await page.getByRole('tab', { name: 'Local Folder' }).click();
    await page.getByTestId('local-path-input').fill(repoDir);
    await capture(page, testInfo, '02-filled-local-path');
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    await expect(page.locator('[data-testid="analyze-progress"]')).toBeVisible({ timeout: 20_000 });
    await capture(page, testInfo, '03-progress');

    const done = page.locator('[data-testid="analyze-done"]');
    const retry = page.getByRole('button', { name: /Try again/ });
    await expect(done.or(retry)).toBeVisible({ timeout: 120_000 });
    if (await retry.isVisible()) {
      throw new Error(`live analyze failed:\n${await page.locator('body').innerText()}`);
    }
    await expect(done).toBeVisible();
    await expect(done.getByText('Analysis complete')).toBeVisible();
    await expect(done.getByText('courses', { exact: true })).toBeVisible();
    await expect(done).not.toContainText(repoDir);
    await expect(done).not.toContainText(fixtures);
    await capture(page, testInfo, '04-done-basename');

    const snap = JSON.stringify(await fetchOps(url));
    expect(snap).toContain('courses');
    expect(snap).not.toContain(repoDir);
    expect(snap).not.toContain('"repoPath"');

    // Reconnect resolves the SSE repoId against /api/repos and loads the exact
    // registered path, never a same-named sibling. The path stays off screen.
    await expect
      .poll(() => repoQueries.length > 0 && repoQueries.every((q) => q === repoDir), {
        timeout: 20_000,
      })
      .toBe(true);
    await capture(page, testInfo, '05-after-complete');
    await assertNoLeaks(page, [fixtures]);
  });
});

test.describe('Analyze — failure, retry, cancel', () => {
  test('missing local path fails and Try again restores the form', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const { fixtures } = requireBackend();
    const notARepo = `${fixtures}/not-a-repo.txt`;
    fs.writeFileSync(notARepo, 'this is a file, not a repository\n');

    await openAnalyzeForm(page);
    await page.getByRole('tab', { name: 'Local Folder' }).click();
    await page.getByTestId('local-path-input').fill(notARepo);
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    await expect(page.getByRole('button', { name: /Try again/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('body')).not.toContainText(TOKEN_LEAK);
    await expect(page.locator('body')).not.toContainText(notARepo);
    await capture(page, testInfo, '07-failed');
    await assertNoLeaks(page, [fixtures, notARepo]);

    await page.getByRole('button', { name: /Try again/ }).click();
    await expect(page.getByRole('tab', { name: 'GitHub URL' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Analyze Repository/ })).toBeVisible();
    await capture(page, testInfo, '08-try-again-form');
  });

  test('cancel during analyze DELETEs the live job and returns the form', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const { url, fixtures } = requireBackend();
    // The previous test's failed local-path job keeps the slot until its worker exits.
    await waitForAnalyzeSlotFree(url);
    const repoDir = writeTinyRepo(fixtures, 'cancel-me');
    const deletes: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().includes('/api/analyze/')) {
        deletes.push(req.url());
      }
    });

    await openAnalyzeForm(page);
    await page.getByRole('tab', { name: 'Local Folder' }).click();
    await page.getByTestId('local-path-input').fill(repoDir);
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    const progress = page.locator('[data-testid="analyze-progress"]');
    await expect(progress).toBeVisible({ timeout: 20_000 });
    await capture(page, testInfo, '09-progress-before-cancel');

    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await expect.poll(() => deletes.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.getByRole('tab', { name: 'GitHub URL' })).toBeVisible({ timeout: 15_000 });
    await expect(progress).toBeHidden();
    await capture(page, testInfo, '10-form-after-cancel');
  });

  test('second analyze while one is running surfaces the live 409', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const { url, fixtures } = requireBackend();
    const first = writeTinyRepo(fixtures, 'lock-a');
    const second = writeTinyRepo(fixtures, 'lock-b');
    await waitForAnalyzeSlotFree(url);
    // A real local analyze holds the slot for the whole UI round trip; a
    // missing-repo clone fails in under a second and would free it early.
    const held = await postAnalyze(url, { path: first });
    expect(held.http).toBe(202);
    expect(held.jobId).toBeTruthy();

    await openAnalyzeForm(page);
    await page.getByRole('tab', { name: 'Local Folder' }).click();
    await page.getByTestId('local-path-input').fill(second);
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    await expect(page.getByText(/already (active|in progress)/i)).toBeVisible({ timeout: 20_000 });
    await capture(page, testInfo, '11-lock-409');
    if (held.jobId) await waitForJob(url, held.jobId);
  });
});

test.describe('Analyze — other sources and token', () => {
  test('optional GitHub token is posted but never painted after a failed clone', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await waitForAnalyzeSlotFree(requireBackend().url);
    let posted: Record<string, unknown> = {};
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/analyze')) {
        posted = (req.postDataJSON() as Record<string, unknown>) ?? {};
      }
    });

    await openAnalyzeForm(page);
    await page.locator('input[type="url"]').fill(MISSING_GITHUB);
    await page.locator('input[type="password"]').fill(TOKEN_LEAK);
    await capture(page, testInfo, '13-token-filled');
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    await expect(page.getByRole('button', { name: /Try again/ })).toBeVisible({ timeout: 120_000 });
    expect(posted).toMatchObject({ url: MISSING_GITHUB, token: TOKEN_LEAK });
    await assertNoLeaks(page);
    await capture(page, testInfo, '14-failed-token-masked');
  });

  test('GitLab URL is posted to the live server and fails closed without leaking the URL host path', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await waitForAnalyzeSlotFree(requireBackend().url);
    let posted: Record<string, unknown> = {};
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/analyze')) {
        posted = (req.postDataJSON() as Record<string, unknown>) ?? {};
      }
    });

    await openAnalyzeForm(page);
    await page.getByRole('tab', { name: 'GitLab URL' }).click();
    await page.locator('input[type="url"]').fill('https://gitlab.com/gitnexus-e2e-missing/project');
    await capture(page, testInfo, '15-gitlab-filled');
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    await expect(page.getByRole('button', { name: /Try again/ })).toBeVisible({ timeout: 120_000 });
    expect(posted).toMatchObject({ url: 'https://gitlab.com/gitnexus-e2e-missing/project' });
    const failureText = page.locator('p.text-red-400');
    await expect(failureText).toBeVisible();
    await expect(failureText).not.toContainText('gitlab.com');
    await expect(failureText).not.toContainText('gitnexus-e2e-missing');
    await capture(page, testInfo, '16-gitlab-failed');
    await assertNoLeaks(page);
  });

  test('folder upload analyzes on the live server and shows the folder name', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const { url, fixtures } = requireBackend();
    await waitForAnalyzeSlotFree(url);
    const fixtureDir = writeTinyRepo(fixtures, 'myrepo');

    await openAnalyzeForm(page);
    await page.getByRole('tab', { name: 'Local Folder' }).click();
    await capture(page, testInfo, '19-local-folder-tab');
    await page.locator('[data-testid="folder-upload-input"]').setInputFiles(fixtureDir);

    const done = page.locator('[data-testid="analyze-done"]');
    const retry = page.getByRole('button', { name: /Try again/ });
    await expect(done.or(retry)).toBeVisible({ timeout: 120_000 });
    if (await retry.isVisible()) {
      throw new Error(
        `live folder-upload analyze failed:\n${await page.locator('body').innerText()}`,
      );
    }
    await expect(done.getByText('myrepo', { exact: true })).toBeVisible();
    await expect(done).not.toContainText(fixtureDir);
    await capture(page, testInfo, '20-folder-upload-done');
    await assertNoLeaks(page, [fixtures]);
  });
});

test.describe('Analyze — form validation and tabs', () => {
  test('invalid GitHub URL keeps Analyze disabled; tabs each have their own form', async ({
    page,
  }, testInfo) => {
    requireBackend();
    await openAnalyzeForm(page);
    const analyzeBtn = page.getByRole('button', { name: /Analyze Repository/ });
    await expect(analyzeBtn).toBeDisabled();

    await page.locator('input[type="url"]').fill('not-a-url');
    await expect(analyzeBtn).toBeDisabled();
    await capture(page, testInfo, '21-invalid-github');

    await page.getByRole('tab', { name: 'GitLab URL' }).click();
    await expect(page.getByPlaceholder('https://gitlab.com/owner/repo')).toBeVisible();
    await capture(page, testInfo, '22-gitlab-tab');

    await page.getByRole('tab', { name: 'Azure DevOps' }).click();
    await expect(
      page.getByPlaceholder('http://azuredevops.example.com/Collection/Project/_git/Repo'),
    ).toBeVisible();
    await capture(page, testInfo, '23-azure-tab');

    await page.getByRole('tab', { name: 'Local Folder' }).click();
    await expect(page.locator('[data-testid="upload-folder"]')).toBeVisible();
    await capture(page, testInfo, '24-local-tab');

    await page.getByRole('tab', { name: 'GitHub URL' }).click();
    await expect(page.locator('input[type="url"]')).toHaveValue('');
    await expect(analyzeBtn).toBeDisabled();
  });
});
