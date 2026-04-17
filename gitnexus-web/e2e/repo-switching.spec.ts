import { test, expect } from '@playwright/test';

/**
 * E2E tests for the repo-switching and false-404 fixes.
 *
 * Most tests use the live backend (same pattern as multi-repo-scoping.spec.ts).
 * The 503 hold-queue test uses route interception to simulate a slow analysis.
 */

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

let firstRepoName: string;

test.beforeAll(async () => {
  if (process.env.E2E) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/repos`);
      const repos = await res.json();
      firstRepoName = repos[0]?.name ?? '';
    } catch {
      firstRepoName = '';
    }
    return;
  }
  try {
    const [backendRes, frontendRes] = await Promise.allSettled([
      fetch(`${BACKEND_URL}/api/repos`),
      fetch(FRONTEND_URL),
    ]);
    if (
      backendRes.status === 'rejected' ||
      (backendRes.status === 'fulfilled' && !backendRes.value.ok)
    ) {
      test.skip(true, 'gitnexus serve not available');
      return;
    }
    if (
      frontendRes.status === 'rejected' ||
      (frontendRes.status === 'fulfilled' && !frontendRes.value.ok)
    ) {
      test.skip(true, 'Vite dev server not available');
      return;
    }
    if (backendRes.status === 'fulfilled') {
      const repos = await backendRes.value.json();
      if (!repos.length) {
        test.skip(true, 'No indexed repos');
        return;
      }
      firstRepoName = repos[0].name;
    }
  } catch {
    test.skip(true, 'servers not available');
  }
});

// ── 1. Hold-queue: 503 → descriptive user message ────────────────────────────

test.describe('Hold-queue timeout error', () => {
  test('shows descriptive message when /api/repo returns 503', async ({ page }, testInfo) => {
    // Intercept only /api/repo (singular) — not /api/repos — to return a 503
    // regex: /api/repo followed by end, ?, or # — NOT /api/repos
    await page.route(/\/api\/repo(?!s)(\?.*)?$/, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: `Repository analysis for "${firstRepoName}" is taking longer than expected. Please try again in a moment.`,
        }),
      }),
    );

    await page.goto(`/?server=${encodeURIComponent(BACKEND_URL)}`);

    // UI should show the 503 error message
    await expect(page.getByText(/taking longer than expected/i)).toBeVisible({
      timeout: 20_000,
    });

    await page.screenshot({ path: testInfo.outputPath('hold-queue-503.png') });
  });
});

// ── 2. ?project= URL persistence ─────────────────────────────────────────────

test.describe('?project= URL persistence', () => {
  test('?project= is set in URL after connecting via ?server=', async ({ page }) => {
    await page.goto(`/?server=${encodeURIComponent(BACKEND_URL)}`);

    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });

    const url = new URL(page.url());
    const project = url.searchParams.get('project');
    expect(project).toBeTruthy();
    // first repo returned by the live backend
    if (firstRepoName) expect(project).toBe(firstRepoName);
  });

  test('?project= is still present after F5 reload', async ({ page }) => {
    await page.goto(`/?server=${encodeURIComponent(BACKEND_URL)}`);
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });

    // After connect, URL has ?server=&project= — F5 re-uses both params
    await page.reload();
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });

    const url = new URL(page.url());
    expect(url.searchParams.get('project')).toBeTruthy();
  });
});

// ── 3. ?project= + ?server= combined auto-connect ────────────────────────────

test.describe('?project= auto-connect', () => {
  test('navigating with ?server=&project= connects to the correct repo', async ({
    page,
  }, testInfo) => {
    if (!firstRepoName) test.skip(true, 'no repo name available');

    await page.goto(
      `/?server=${encodeURIComponent(BACKEND_URL)}&project=${encodeURIComponent(firstRepoName)}`,
    );

    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });

    // ?project= in URL should match what we passed in
    const url = new URL(page.url());
    expect(url.searchParams.get('project')).toBe(firstRepoName);

    await page.screenshot({ path: testInfo.outputPath('project-param-connect.png') });
  });
});

// ── 4. Windows path normalization ─────────────────────────────────────────────

test.describe('Windows path normalization', () => {
  test('project name uses basename when /api/repo returns a Windows-style repoPath', async ({
    page,
  }) => {
    const repoName = firstRepoName || 'test-repo';
    const windowsPath = `C:\\Users\\LENOVO\\.gitnexus\\repos\\${repoName}`;

    // Mock /api/repo to return a Windows backslash path while keeping name correct
    await page.route(/\/api\/repo(?!s)(\?.*)?$/, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          // intentionally omit `name` to force path-based extraction
          path: windowsPath,
          repoPath: windowsPath,
        }),
      }),
    );

    await page.goto(`/?server=${encodeURIComponent(BACKEND_URL)}`);

    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });

    // URL ?project= must be the short basename, NOT the full Windows path
    const url = new URL(page.url());
    const project = url.searchParams.get('project');
    expect(project).toBeTruthy();
    expect(project).not.toContain('\\');
    expect(project).not.toContain('LENOVO');
    expect(project).toBe(repoName);
  });
});
