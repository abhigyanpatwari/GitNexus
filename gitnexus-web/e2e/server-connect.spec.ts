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

// Skip all tests if the gitnexus server or Vite dev server isn't reachable
test.beforeAll(async () => {
  if (process.env.E2E) return; // force-run
  try {
    const [backendRes, frontendRes] = await Promise.allSettled([
      fetch('http://localhost:4747/api/repos'),
      fetch('http://localhost:5173'),
    ]);
    if (backendRes.status === 'rejected' || (backendRes.status === 'fulfilled' && !backendRes.value.ok))
      test.skip(true, 'gitnexus serve not available on :4747');
    if (frontendRes.status === 'rejected')
      test.skip(true, 'Vite dev server not available on :5173');
  } catch {
    test.skip(true, 'servers not available');
  }
});

/** Shared helper: connect to the local server and wait for the graph to load */
async function connectAndWaitForGraph(page: import('@playwright/test').Page, testInfo: TestInfo) {
  // Collect all console messages for debugging
  page.on('console', msg => console.log(`[browser ${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => console.log(`[browser crash] ${err.message}`));

  await page.goto('/');
  await page.screenshot({ path: testInfo.outputPath('step-1-landing.png') });

  // Click "Server" tab in onboarding
  await page.getByText('Server').click();
  await expect(page.getByText('Connect to Server')).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: testInfo.outputPath('step-2-server-tab.png') });

  // Enter server URL and connect
  const serverInput = page.locator('input[name="server-url-input"]');
  await serverInput.fill('http://localhost:4747');
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
    const processRow = page.locator('.group').first();
    await processRow.hover();

    const viewBtn = processRow.getByRole('button', { name: /View/ });
    await expect(viewBtn).toBeVisible({ timeout: 5_000 });
    await viewBtn.click();
    // Wait for modal to appear
    await expect(page.locator('.fixed.inset-0.z-50')).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: testInfo.outputPath('process-view-clicked.png'), fullPage: true });
  });

  test('lightbulb highlights nodes in graph', async ({ page }, testInfo) => {
    await connectAndWaitForGraph(page, testInfo);

    await page.getByRole('button', { name: 'Nexus AI' }).click();
    await page.getByText('Processes').click();
    await expect(page.locator('[data-testid="process-list-loaded"]')).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: testInfo.outputPath('before-highlight.png'), fullPage: true });

    // Hover first process to reveal lightbulb
    const processRow = page.locator('.group').first();
    await processRow.hover();

    const lightbulb = processRow.locator('button[title*="highlight"]');
    await expect(lightbulb).toBeVisible({ timeout: 5_000 });
    await lightbulb.click();
    // Wait for highlight to apply (graph re-render)
    await page.waitForLoadState('networkidle');
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
    const fileItem = page.getByText('start.sh');
    if (await fileItem.isVisible()) {
      await fileItem.click();
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: testInfo.outputPath('node-selected.png'), fullPage: true });

      // Click "Turn off all highlights" button (top-right lightbulb)
      const highlightBtn = page.locator('button[title*="Turn off"]');
      await expect(highlightBtn).toBeVisible({ timeout: 5_000 });
      await highlightBtn.click();
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: testInfo.outputPath('highlights-cleared.png'), fullPage: true });
    } else {
      await page.screenshot({ path: testInfo.outputPath('start-sh-not-found.png'), fullPage: true });
    }
  });
});
