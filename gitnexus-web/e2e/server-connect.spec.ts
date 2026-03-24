import { test, expect, type TestInfo } from '@playwright/test';

/**
 * E2E tests for the GitNexus web UI.
 * Requires:
 *   - gitnexus serve running on localhost:4747
 *   - gitnexus-web dev server running on localhost:5173
 *
 * Skipped when servers aren't available (CI without services, etc.).
 * Set E2E=1 to force-run even without the availability check.
 */

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';
// Skip all tests if the gitnexus server or Vite dev server isn't reachable
test.beforeAll(async () => {
  if (process.env.E2E) return; // force-run
  try {
    const [backendRes, frontendRes] = await Promise.allSettled([
      fetch(`${BACKEND_URL}/api/repos`),
      fetch(FRONTEND_URL),
    ]);
    if (backendRes.status === 'rejected' || (backendRes.status === 'fulfilled' && !backendRes.value.ok)) {
      test.skip(true, 'gitnexus serve not available on :4747');
      return;
    }
    if (frontendRes.status === 'rejected' || (frontendRes.status === 'fulfilled' && !frontendRes.value.ok)) {
      test.skip(true, 'Vite dev server not available on :5173');
      return;
    }
  } catch {
    test.skip(true, 'servers not available');
  }
});

/** Shared helper: connect to the local server and wait for the graph to load */
async function connectAndWaitForGraph(page: import('@playwright/test').Page, testInfo: TestInfo) {
  // Signal to the app that we are running under Playwright (used to skip heavy Ladybug loads).
  await page.addInitScript(() => {
    (window as unknown as { __PLAYWRIGHT_TEST__?: boolean }).__PLAYWRIGHT_TEST__ = true;
  });

  await page.goto('/');

  // Wait for the app to fully render before interacting
  const serverTab = page.getByRole('button', { name: 'Server' });
  await expect(serverTab).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath('step-1-landing.png') });

  // Click "Server" tab and wait for the input to appear
  await serverTab.click();
  const serverInput = page.locator('input[name="server-url-input"]');
  await expect(serverInput).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath('step-2-server-tab.png') });
  await serverInput.fill(BACKEND_URL);
  await page.screenshot({ path: testInfo.outputPath('step-3-url-filled.png') });

  await page.getByRole('button', { name: /Connect/ }).click();

  // Wait for graph to load — status bar shows "Ready"
  await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/\d+ nodes/).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('step-4-graph-loaded.png') });
}

test.describe('Server Connection & Graph Loading', () => {
  test('connects to server and loads graph', async ({ page }, testInfo) => {
    await connectAndWaitForGraph(page, testInfo);
    await page.screenshot({ path: testInfo.outputPath('graph-loaded.png'), fullPage: true });
  });
});

test.describe('Nexus AI', () => {
  test('panel opens and agent initializes without error', async ({ page }, testInfo) => {
    await connectAndWaitForGraph(page, testInfo);

    // Click Nexus AI button to open the panel
    await page.getByRole('button', { name: 'Nexus AI' }).click();

    // Should see the Nexus AI tab content
    await expect(page.getByText('Ask me anything')).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: testInfo.outputPath('nexus-ai-panel.png'), fullPage: true });

    // "Database not ready" should NOT be visible
    const errorBanner = page.getByText('Database not ready');
    expect(await errorBanner.isVisible().catch(() => false)).toBe(false);
  });
});

test.describe('Processes Panel', () => {
  test('shows process list and View button works', async ({ page }, testInfo) => {
    await connectAndWaitForGraph(page, testInfo);

    // Open Nexus AI panel, switch to Processes tab
    await page.getByRole('button', { name: 'Nexus AI' }).click();
    await page.getByText('Processes').click();

    // Should show process count — wait for data-testid instead of fixed timeout
    await expect(page.locator('[data-testid="process-list-loaded"]')).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: testInfo.outputPath('processes-panel.png'), fullPage: true });

    // Hover first process item to reveal View button, then click it
    const processRow = page.locator('[data-testid="process-row"]').first();
    await expect(processRow).toBeVisible({ timeout: 10_000 });
    await processRow.hover();

    const viewBtn = processRow.locator('[data-testid="process-view-button"]');
    await viewBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await viewBtn.click();
    // Wait for modal to appear
    await expect(page.locator('[data-testid="process-modal"]')).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: testInfo.outputPath('process-view-clicked.png'), fullPage: true });
  });

  test('lightbulb highlights nodes in graph', async ({ page }, testInfo) => {
    await connectAndWaitForGraph(page, testInfo);

    await page.getByRole('button', { name: 'Nexus AI' }).click();
    await page.getByText('Processes').click();
    await expect(page.locator('[data-testid="process-list-loaded"]')).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: testInfo.outputPath('before-highlight.png'), fullPage: true });

    // Hover first process to reveal lightbulb
    const processRow = page.locator('[data-testid="process-row"]').first();
    await expect(processRow).toBeVisible({ timeout: 10_000 });
    await processRow.hover();

    const lightbulb = processRow.locator('[data-testid="process-highlight-button"]');
    await lightbulb.waitFor({ state: 'visible', timeout: 5_000 });
    await lightbulb.click();
    // Wait for highlight to apply — the process row gets amber styling when focused
    await expect(processRow).toHaveClass(/bg-amber-950/, { timeout: 5_000 });
    await page.screenshot({ path: testInfo.outputPath('after-highlight.png'), fullPage: true });
  });
});

test.describe('Turn Off All Highlights', () => {
  test('selecting a node dims others, button clears it', async ({ page }, testInfo) => {
    await connectAndWaitForGraph(page, testInfo);

    // Wait for graph to fully render by checking for canvas element
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: testInfo.outputPath('before-select.png'), fullPage: true });

    // Click a file in the file tree to select a node
    const fileItem = page.getByText('package.json').first();
    await expect(fileItem).toBeVisible({ timeout: 10_000 });
    await fileItem.click();

    // Wait for highlight toggle to show "Turn off" (indicates highlights are active)
    const highlightToggle = page.locator('[data-testid="ai-highlights-toggle"]');
    await expect(highlightToggle).toHaveAttribute('title', 'Turn off all highlights', { timeout: 5_000 });
    await page.screenshot({ path: testInfo.outputPath('node-selected.png'), fullPage: true });

    // Click the toggle to clear all highlights
    await highlightToggle.click();

    // Verify highlights are now off — button title changes to "Turn on"
    await expect(highlightToggle).toHaveAttribute('title', 'Turn on AI highlights', { timeout: 5_000 });
    await page.screenshot({ path: testInfo.outputPath('highlights-cleared.png'), fullPage: true });
  });
});
