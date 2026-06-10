import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * E2E for the browser folder-upload flow (replaces the removed server-side
 * directory picker). Mocks the backend so no live gitnexus server is needed.
 */

const BACKEND_URL = 'http://localhost:4747';

let fixtureDir: string;

test.beforeAll(() => {
  // A tiny "repo" folder; Playwright sets webkitRelativePath = <folder>/<file>.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-upload-e2e-'));
  fixtureDir = path.join(root, 'myrepo');
  fs.mkdirSync(path.join(fixtureDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'README.md'), '# hi\n');
  fs.writeFileSync(path.join(fixtureDir, 'src', 'index.ts'), 'export const x = 1;\n');
});

test.beforeEach(async ({ page }) => {
  await page.route(`${BACKEND_URL}/api/repos`, (route) => route.fulfill({ json: [] }));
  await page.route(`${BACKEND_URL}/api/info`, (route) =>
    route.fulfill({ json: { version: '1.0.0', launchContext: 'npx', nodeVersion: 'v22.0.0' } }),
  );
  await page.route(`${BACKEND_URL}/api/heartbeat`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: ':ok\n\n',
    }),
  );
});

test('uploading a folder posts a multipart upload and starts analysis', async ({ page }) => {
  let uploadContentType = '';
  await page.route(`${BACKEND_URL}/api/analyze/upload`, async (route) => {
    uploadContentType = route.request().headers()['content-type'] ?? '';
    await route.fulfill({ json: { jobId: 'job-e2e', status: 'analyzing' } });
  });
  // SSE progress → immediately complete.
  await page.route(`${BACKEND_URL}/api/analyze/job-e2e/progress`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: 'event: complete\ndata: {"repoName":"myrepo"}\n\n',
    }),
  );

  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Local Folder' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Local Folder' }).click();

  await expect(page.locator('[data-testid="upload-folder"]')).toBeVisible();

  // Select the fixture folder via the hidden webkitdirectory input.
  await page.locator('[data-testid="folder-upload-input"]').setInputFiles(fixtureDir);

  // The upload endpoint should be hit with a multipart body, and the UI should
  // leave the input phase (upload button no longer shown).
  await expect.poll(() => uploadContentType).toContain('multipart/form-data');
  await expect(page.locator('[data-testid="upload-folder"]')).toBeHidden({ timeout: 10_000 });
});

test('switching modes mid-upload aborts it and never shows progress', async ({ page }) => {
  // Hold the upload response until the test releases it, so the mode switch
  // happens while the POST is in flight (the review 4470339833 repro).
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((res) => (releaseUpload = res));
  let uploadAborted = false;
  let progressOpened = false;

  // The client-side AbortController kills the POST at mode-switch time; that
  // surfaces as a failed request (net::ERR_ABORTED), not as a response.
  page.on('requestfailed', (req) => {
    if (req.url().includes('/api/analyze/upload') && /ABORTED/.test(req.failure()?.errorText ?? ''))
      uploadAborted = true;
  });
  await page.route(`${BACKEND_URL}/api/analyze/upload`, async (route) => {
    await uploadGate;
    await route.fulfill({ json: { jobId: 'job-stale', status: 'analyzing' } }).catch(() => {}); // the request may already be gone — that's the point
  });
  await page.route(`${BACKEND_URL}/api/analyze/job-stale/progress`, (route) => {
    progressOpened = true;
    return route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: 'event: complete\ndata: {"repoName":"myrepo"}\n\n',
    });
  });

  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Local Folder' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Local Folder' }).click();
  await page.locator('[data-testid="folder-upload-input"]').setInputFiles(fixtureDir);
  await expect(page.locator('[data-testid="upload-progress"]')).toBeVisible();

  // Switch back to GitHub while the upload POST is still pending, then let
  // the (now-stale) route handler finish.
  await page.getByRole('tab', { name: 'GitHub URL' }).click();
  await expect.poll(() => uploadAborted, { timeout: 10_000 }).toBe(true);
  releaseUpload();

  // The GitHub form stays clean (no error, immediately usable), and no SSE
  // progress stream is ever opened by the stale upload.
  await expect(page.getByPlaceholder('https://github.com/owner/repo')).toBeEditable();
  await expect(page.locator('[data-testid="upload-progress"]')).toBeHidden();
  expect(progressOpened).toBe(false);
});
