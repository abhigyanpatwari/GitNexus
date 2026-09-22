import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKEND_URL,
  HOME_LEAK,
  TOKEN_LEAK,
  assertNoLeaks,
  capture,
  mockIdleBackend,
  openAnalyzeForm,
  progressSse,
  sseBody,
} from './helpers/public-contract';

/**
 * User-case e2e for the public analyze SSE contract:
 *   - complete frames carry repoName only
 *   - failed frames show a redacted error
 *   - Cancel DELETEs the running job and returns the form
 *
 * Mocks :4747 so this file does not need a live gitnexus server.
 */

const JOB_ID = 'job-public-sse';
const REPO_NAME = 'courses';
const GITHUB_URL = 'https://github.com/anthropics/courses';

async function mockAnalyzePost(
  page: Page,
  opts: {
    jobId?: string;
    onBody?: (body: Record<string, unknown>) => void;
    status?: number;
    json?: unknown;
  } = {},
) {
  const jobId = opts.jobId ?? JOB_ID;
  await page.route(`${BACKEND_URL}/api/analyze`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const raw = route.request().postData();
    if (raw && opts.onBody) opts.onBody(JSON.parse(raw) as Record<string, unknown>);
    if (opts.status && opts.status >= 400) {
      await route.fulfill({
        status: opts.status,
        json: opts.json ?? { error: 'request failed' },
      });
      return;
    }
    await route.fulfill({ json: opts.json ?? { jobId, status: 'cloning' } });
  });
}

async function mockProgress(page: Page, jobId: string, body: string) {
  await page.route(`${BACKEND_URL}/api/analyze/${jobId}/progress`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body,
    }),
  );
}

async function mockRepoAndGraph(page: Page, repoQueries: string[], name = REPO_NAME) {
  // Keep /api/repos empty until reconnect so the landing form still appears.
  let listed = false;
  await page.route(
    (url) => url.origin === BACKEND_URL && url.pathname === '/api/repo',
    async (route) => {
      listed = true;
      const repo = new URL(route.request().url()).searchParams.get('repo') ?? '';
      repoQueries.push(repo);
      await route.fulfill({
        json: {
          name,
          stats: { files: 1, nodes: 2, edges: 1 },
        },
      });
    },
  );
  await page.route(
    (url) => url.origin === BACKEND_URL && url.pathname === '/api/graph',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        json: { nodes: [], relationships: [] },
      }),
  );
  await page.route(`${BACKEND_URL}/api/repos`, (route) =>
    route.fulfill({
      json: listed ? [{ name, path: name, repoPath: name }] : [],
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await mockIdleBackend(page);
});

test.describe('Analyze — happy path', () => {
  test('GitHub URL → progress → done by repoName → reconnect without a path', async ({
    page,
  }, testInfo) => {
    const repoQueries: string[] = [];
    let progressHits = 0;
    await mockAnalyzePost(page);
    await page.route(`${BACKEND_URL}/api/analyze/${JOB_ID}/progress`, async (route) => {
      progressHits += 1;
      if (progressHits === 1) {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          body: progressSse({ phase: 'cloning', percent: 22, message: 'Cloning [repo]...' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: sseBody('complete', { repoName: REPO_NAME }),
      });
    });
    await mockRepoAndGraph(page, repoQueries);

    await openAnalyzeForm(page);
    await capture(page, testInfo, '01-empty-form');

    const urlInput = page.locator('input[type="url"]');
    await urlInput.fill(GITHUB_URL);
    await expect(page.getByRole('button', { name: /Analyze Repository/ })).toBeEnabled();
    await capture(page, testInfo, '02-filled-github');

    await page.getByRole('button', { name: /Analyze Repository/ }).click();
    await expect(page.locator('[data-testid="analyze-progress"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Cloning repository')).toBeVisible();
    await expect(page.getByText('22%')).toBeVisible();
    await capture(page, testInfo, '03-cloning-progress');

    const done = page.locator('[data-testid="analyze-done"]');
    await expect(done).toBeVisible({ timeout: 15_000 });
    await expect(done.getByText('Analysis complete')).toBeVisible();
    await expect(done.getByText(REPO_NAME, { exact: true })).toBeVisible();
    await expect(done.getByText('Loading graph...')).toBeVisible();
    await expect(done).not.toContainText(HOME_LEAK);
    await expect(done).not.toContainText('/tmp/');
    await expect(done).not.toContainText(GITHUB_URL);
    await capture(page, testInfo, '04-done-basename');

    await expect
      .poll(() => repoQueries.some((q) => q === REPO_NAME), { timeout: 15_000 })
      .toBe(true);
    expect(repoQueries.join('\n')).not.toContain(HOME_LEAK);
    expect(repoQueries.join('\n')).not.toContain('/home/');
    await capture(page, testInfo, '05-reconnect-by-name');
    await assertNoLeaks(page);
  });

  test('done screen hides a leaked repoPath on the complete frame', async ({ page }, testInfo) => {
    const repoQueries: string[] = [];
    await mockAnalyzePost(page);
    await mockProgress(
      page,
      JOB_ID,
      sseBody('complete', { repoName: REPO_NAME, repoPath: HOME_LEAK }),
    );
    await mockRepoAndGraph(page, repoQueries);

    await openAnalyzeForm(page);
    await page.locator('input[type="url"]').fill(GITHUB_URL);
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    const done = page.locator('[data-testid="analyze-done"]');
    await expect(done).toBeVisible({ timeout: 10_000 });
    await expect(done.getByText(REPO_NAME, { exact: true })).toBeVisible();
    await expect(done).not.toContainText(HOME_LEAK);
    await expect(done).not.toContainText('/home/');
    await capture(page, testInfo, '06-done-ignores-leaked-path');
    await assertNoLeaks(page);
  });
});

test.describe('Analyze — failure, retry, cancel', () => {
  test('failed SSE shows the redacted error and Try again restores the form', async ({
    page,
  }, testInfo) => {
    await mockAnalyzePost(page);
    await mockProgress(
      page,
      JOB_ID,
      sseBody('failed', { repoName: REPO_NAME, error: 'fatal: unable to access [repo]' }),
    );

    await openAnalyzeForm(page);
    await page.locator('input[type="url"]').fill(GITHUB_URL);
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    await expect(page.getByText('fatal: unable to access [repo]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Try again/ })).toBeVisible();
    await capture(page, testInfo, '07-failed-redacted');
    await assertNoLeaks(page);

    await page.getByRole('button', { name: /Try again/ }).click();
    await expect(page.getByRole('tab', { name: 'GitHub URL' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Analyze Repository/ })).toBeVisible();
    await capture(page, testInfo, '08-try-again-form');
  });

  test('cancel during analyze DELETEs the job and returns the form', async ({ page }, testInfo) => {
    let deletedJob: string | undefined;
    await mockAnalyzePost(page);
    await page.route(`${BACKEND_URL}/api/analyze/${JOB_ID}`, async (route) => {
      if (route.request().method() === 'DELETE') {
        deletedJob = JOB_ID;
        await route.fulfill({ json: { id: JOB_ID, status: 'failed', error: 'Cancelled by user' } });
        return;
      }
      await route.fallback();
    });
    await page.route(`${BACKEND_URL}/api/analyze/${JOB_ID}/progress`, async () => {
      await new Promise(() => undefined);
    });

    await openAnalyzeForm(page);
    await page.locator('input[type="url"]').fill(GITHUB_URL);
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    const progress = page.locator('[data-testid="analyze-progress"]');
    await expect(progress).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Queued')).toBeVisible();
    await capture(page, testInfo, '09-progress-before-cancel');

    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await expect.poll(() => deletedJob, { timeout: 10_000 }).toBe(JOB_ID);
    await expect(page.getByRole('tab', { name: 'GitHub URL' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Analyze Repository/ })).toBeVisible();
    await expect(progress).toBeHidden();
    await capture(page, testInfo, '10-form-after-cancel');
  });

  test('409 lock surfaces as a client error the user can retry', async ({ page }, testInfo) => {
    let attempts = 0;
    await page.route(`${BACKEND_URL}/api/analyze`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({
          status: 409,
          json: { error: 'Another job is already active for this repository' },
        });
        return;
      }
      await route.fulfill({ json: { jobId: JOB_ID, status: 'cloning' } });
    });
    await mockProgress(page, JOB_ID, sseBody('complete', { repoName: REPO_NAME }));

    await openAnalyzeForm(page);
    await page.locator('input[type="url"]').fill(GITHUB_URL);
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    await expect(
      page.getByText('Request failed: Another job is already active for this repository'),
    ).toBeVisible({ timeout: 10_000 });
    await capture(page, testInfo, '11-lock-409');

    await page.getByRole('button', { name: /Try again/ }).click();
    await page.getByRole('button', { name: /Analyze Repository/ }).click();
    await expect(page.locator('[data-testid="analyze-done"]')).toBeVisible({ timeout: 10_000 });
    await capture(page, testInfo, '12-lock-retried');
    expect(attempts).toBe(2);
  });
});

test.describe('Analyze — other sources and token', () => {
  test('optional GitHub token is posted but never painted after a failed clone', async ({
    page,
  }, testInfo) => {
    let posted: Record<string, unknown> = {};
    await mockAnalyzePost(page, { onBody: (body) => (posted = body) });
    await mockProgress(
      page,
      JOB_ID,
      sseBody('failed', { repoName: REPO_NAME, error: 'fatal: unable to access [repo]' }),
    );

    await openAnalyzeForm(page);
    await page.locator('input[type="url"]').fill(GITHUB_URL);
    const tokenInput = page.locator('input[type="password"]');
    await tokenInput.fill(TOKEN_LEAK);
    await capture(page, testInfo, '13-token-filled');
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    await expect(page.getByText('fatal: unable to access [repo]')).toBeVisible({ timeout: 10_000 });
    expect(posted).toMatchObject({ url: GITHUB_URL, token: TOKEN_LEAK });
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(TOKEN_LEAK);
    expect(body).not.toContain('ghs_secret');
    await capture(page, testInfo, '14-failed-token-masked');
  });

  test('GitLab URL completes by repoName only', async ({ page }, testInfo) => {
    const repoQueries: string[] = [];
    let posted: Record<string, unknown> = {};
    await mockAnalyzePost(page, { onBody: (body) => (posted = body) });
    await mockProgress(page, JOB_ID, sseBody('complete', { repoName: 'project' }));
    await mockRepoAndGraph(page, repoQueries, 'project');

    await openAnalyzeForm(page);
    await page.getByRole('tab', { name: 'GitLab URL' }).click();
    await page.locator('input[type="url"]').fill('https://gitlab.com/group/project');
    await capture(page, testInfo, '15-gitlab-filled');
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    const done = page.locator('[data-testid="analyze-done"]');
    await expect(done).toBeVisible({ timeout: 10_000 });
    await expect(done.getByText('project', { exact: true })).toBeVisible();
    expect(posted).toMatchObject({ url: 'https://gitlab.com/group/project' });
    await capture(page, testInfo, '16-gitlab-done');
  });

  test('typed local path completes with the folder basename, not the path', async ({
    page,
  }, testInfo) => {
    const repoQueries: string[] = [];
    let posted: Record<string, unknown> = {};
    await mockAnalyzePost(page, { onBody: (body) => (posted = body) });
    await mockProgress(page, JOB_ID, sseBody('complete', { repoName: 'demo' }));
    await mockRepoAndGraph(page, repoQueries, 'demo');

    await openAnalyzeForm(page);
    await page.getByRole('tab', { name: 'Local Folder' }).click();
    await page.getByPlaceholder('/home/you/project').fill('/opt/repos/demo');
    await capture(page, testInfo, '17-local-path-filled');
    await page.getByRole('button', { name: /Analyze Repository/ }).click();

    const done = page.locator('[data-testid="analyze-done"]');
    await expect(done).toBeVisible({ timeout: 10_000 });
    await expect(done.getByText('demo', { exact: true })).toBeVisible();
    await expect(done).not.toContainText('/opt/repos');
    expect(posted).toMatchObject({ path: '/opt/repos/demo' });
    await capture(page, testInfo, '18-local-path-done');
  });

  test('folder upload reaches the done screen with the folder name', async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-upload-e2e-'));
    const fixtureDir = path.join(root, 'myrepo');
    fs.mkdirSync(path.join(fixtureDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'README.md'), '# hi\n');

    await page.route(`${BACKEND_URL}/api/analyze/upload`, async (route) => {
      await route.fulfill({ json: { jobId: 'job-upload', status: 'analyzing' } });
    });
    await mockProgress(page, 'job-upload', sseBody('complete', { repoName: 'myrepo' }));

    await openAnalyzeForm(page);
    await page.getByRole('tab', { name: 'Local Folder' }).click();
    await capture(page, testInfo, '19-local-folder-tab');
    await page.locator('[data-testid="folder-upload-input"]').setInputFiles(fixtureDir);

    const done = page.locator('[data-testid="analyze-done"]');
    await expect(done).toBeVisible({ timeout: 15_000 });
    await expect(done.getByText('myrepo', { exact: true })).toBeVisible();
    await expect(done).not.toContainText(fixtureDir);
    await capture(page, testInfo, '20-folder-upload-done');
  });
});

test.describe('Analyze — form validation and tabs', () => {
  test('invalid GitHub URL keeps Analyze disabled; tabs each have their own form', async ({
    page,
  }, testInfo) => {
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
