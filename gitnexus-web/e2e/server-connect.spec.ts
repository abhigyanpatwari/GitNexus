import { test, expect, type TestInfo } from '@playwright/test';

/**
 * E2E tests for the GitNexus web UI — exploring view features.
 *
 * Requires:
 *   - gitnexus serve running on localhost:4747 with at least one indexed repo
 *   - gitnexus-web dev server running on localhost:5173
 *
 * Skipped when servers aren't available (CI without services, etc.).
 * Set E2E=1 to force-run even without the availability check.
 */

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

test.beforeAll(async () => {
  if (process.env.E2E) return;
  try {
    const [backendRes, frontendRes] = await Promise.allSettled([
      fetch(`${BACKEND_URL}/api/repos`),
      fetch(FRONTEND_URL),
    ]);
    if (
      backendRes.status === 'rejected' ||
      (backendRes.status === 'fulfilled' && !backendRes.value.ok)
    ) {
      test.skip(true, 'gitnexus serve not available on :4747');
      return;
    }
    if (
      frontendRes.status === 'rejected' ||
      (frontendRes.status === 'fulfilled' && !frontendRes.value.ok)
    ) {
      test.skip(true, 'Vite dev server not available on :5173');
      return;
    }
    // Check there's at least one indexed repo
    if (backendRes.status === 'fulfilled') {
      const repos = await backendRes.value.json();
      if (!repos.length) {
        test.skip(true, 'No indexed repos — run gitnexus analyze first');
        return;
      }
    }
  } catch {
    test.skip(true, 'servers not available');
  }
});

/**
 * Wait for the server-detection flow to complete.
 *
 * The app auto-detects the server, then either:
 *   - shows the landing screen when indexed repos exist, or
 *   - goes straight into analyze onboarding when there are zero repos.
 *
 * For these tests we require at least one indexed repo, so pick the first
 * landing card when present and then wait for the exploring view.
 */
async function waitForGraphLoaded(page: import('@playwright/test').Page, testInfo: TestInfo) {
  await page.goto('/');

  const landingCard = page.locator('[data-testid="landing-repo-card"]').first();
  try {
    await landingCard.waitFor({ state: 'visible', timeout: 15_000 });
    await landingCard.click();
  } catch {
    // Landing screen may not appear (e.g. ?server auto-connect)
  }

  await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/\d+ nodes/).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('graph-loaded.png') });
}

test.describe('Server Connection & Graph Loading', () => {
  test('selects a repo from landing and loads graph', async ({ page }, testInfo) => {
    await waitForGraphLoaded(page, testInfo);
    await page.screenshot({ path: testInfo.outputPath('graph-loaded-full.png'), fullPage: true });
  });
});

test.describe('Nexus AI', () => {
  test('panel opens and agent initializes without error', async ({ page }, testInfo) => {
    await waitForGraphLoaded(page, testInfo);

    await page.getByRole('button', { name: 'Nexus AI' }).click();
    await expect(page.getByText('Ask me anything')).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: testInfo.outputPath('nexus-ai-panel.png'), fullPage: true });

    const errorBanner = page.getByText('Database not ready');
    expect(await errorBanner.isVisible().catch(() => false)).toBe(false);
  });
});

test.describe('Processes Panel', () => {
  test('shows process list and View button works', async ({ page }, testInfo) => {
    await waitForGraphLoaded(page, testInfo);

    await page.getByRole('button', { name: 'Nexus AI' }).click();
    await page.getByText('Processes').click();

    await expect(page.locator('[data-testid="process-list-loaded"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: testInfo.outputPath('processes-panel.png'), fullPage: true });

    const processRow = page.locator('[data-testid="process-row"]').first();
    await expect(processRow).toBeVisible({ timeout: 10_000 });
    await processRow.hover();

    const viewBtn = processRow.locator('[data-testid="process-view-button"]');
    await viewBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await viewBtn.click();
    await expect(page.locator('[data-testid="process-modal"]')).toBeVisible({ timeout: 5_000 });
    await page.screenshot({
      path: testInfo.outputPath('process-view-clicked.png'),
      fullPage: true,
    });
  });

  test('lightbulb highlights nodes in graph', async ({ page }, testInfo) => {
    await waitForGraphLoaded(page, testInfo);

    await page.getByRole('button', { name: 'Nexus AI' }).click();
    await page.getByText('Processes').click();
    await expect(page.locator('[data-testid="process-list-loaded"]')).toBeVisible({
      timeout: 15_000,
    });

    const processRow = page.locator('[data-testid="process-row"]').first();
    await expect(processRow).toBeVisible({ timeout: 10_000 });
    await processRow.hover();

    const lightbulb = processRow.locator('[data-testid="process-highlight-button"]');
    await lightbulb.waitFor({ state: 'visible', timeout: 5_000 });
    await lightbulb.click();
    await expect(processRow).toHaveClass(/bg-amber-950/, { timeout: 5_000 });
    await page.screenshot({ path: testInfo.outputPath('after-highlight.png'), fullPage: true });
  });
});

test.describe('Turn Off All Highlights', () => {
  test('selecting a node dims others, button clears it', async ({ page }, testInfo) => {
    await waitForGraphLoaded(page, testInfo);

    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 });

    const fileItem = page.getByText('package.json').first();
    await expect(fileItem).toBeVisible({ timeout: 10_000 });
    await fileItem.click();

    const highlightToggle = page.locator('[data-testid="ai-highlights-toggle"]');
    await expect(highlightToggle).toHaveAttribute('title', 'Turn off all highlights', {
      timeout: 5_000,
    });

    await highlightToggle.click();
    await expect(highlightToggle).toHaveAttribute('title', 'Turn on AI highlights', {
      timeout: 5_000,
    });
    await page.screenshot({ path: testInfo.outputPath('highlights-cleared.png'), fullPage: true });
  });
});
