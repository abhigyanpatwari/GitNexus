import { expect, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKEND_URL = 'http://localhost:4747';
export const HOME_LEAK = '/home/alice/src/private-repo';
export const TOKEN_LEAK = 'ghs_secret_e2e_token';
export const CLONE_LEAK =
  'https://x-access-token:ghs_secret_e2e_token@github.com/user/private-repo.git';
export const WIN_LEAK = 'C:\\Users\\alice\\src\\private-repo';

const GALLERY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');

/** Full-page shot into the test output *and* the review gallery. */
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
  for (const leak of [
    HOME_LEAK,
    TOKEN_LEAK,
    CLONE_LEAK,
    WIN_LEAK,
    'ghs_secret',
    'x-access-token',
    ...extra,
  ]) {
    expect(body, `page must not show ${leak}`).not.toContain(leak);
  }
  expect(body).not.toMatch(/[A-Za-z]:\\Users\\/);
}

export async function mockIdleBackend(page: Page): Promise<void> {
  await page.route(`${BACKEND_URL}/api/repos`, (route) => route.fulfill({ json: [] }));
  await page.route(`${BACKEND_URL}/api/info`, (route) =>
    route.fulfill({ json: { version: '1.6.11', launchContext: 'npx', nodeVersion: 'v22.0.0' } }),
  );
  await page.route(`${BACKEND_URL}/api/health`, (route) =>
    route.fulfill({ status: 200, body: 'ok' }),
  );
  await page.route(`${BACKEND_URL}/api/heartbeat`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: ':ok\n\n',
    }),
  );
}

export async function openAnalyzeForm(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'GitHub URL' })).toBeVisible({ timeout: 20_000 });
}

export const emptyMetrics = {
  total: 0,
  active: 0,
  queued: 0,
  complete: 0,
  failed: 0,
  byStatus: {
    queued: 0,
    cloning: 0,
    analyzing: 0,
    loading: 0,
    complete: 0,
    failed: 0,
  },
  avgDurationMs: null as number | null,
  maxDurationMs: null as number | null,
  activeProgressSum: 0,
};

export function sseBody(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function progressSse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
