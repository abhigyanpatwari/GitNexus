import { test, expect } from '@playwright/test';

/**
 * Debug harnesses for investigating specific UI issues.
 * Excluded from `npm run test:e2e` via testIgnore in playwright.config.ts.
 * Run directly: DEBUG_E2E=1 npx playwright test e2e/debug-issues.spec.ts
 */
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const debugTest = process.env.DEBUG_E2E ? test : test.skip;

async function connectToServer(page: import('@playwright/test').Page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[error] ${msg.text()}`);
  });

  await page.goto('/');
  await page.getByText('Server').click();
  const serverInput = page.locator('input[name="server-url-input"]');
  await serverInput.fill(BACKEND_URL);
  await page.getByRole('button', { name: /Connect/ }).click();
  await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });
  // Wait for LadybugDB to finish loading — poll isDatabaseReady via process list visibility
  await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });
}

debugTest('debug: process view Reset View button', async ({ page }, testInfo) => {
  await connectToServer(page);

  // Open Processes tab
  await page.getByRole('button', { name: 'Nexus AI' }).click();
  await page.getByText('Processes').click();
  await expect(page.getByText(/\d+ processes detected/)).toBeVisible({ timeout: 10_000 });

  // Click View on the first Cross-Community process
  // The View button has opacity-0 by default, use JS click to bypass
  const viewButtons = page.locator('button:has-text("View")');
  const count = await viewButtons.count();
  console.log(`Found ${count} View buttons`);

  // Use evaluate to click the first one regardless of visibility
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.textContent?.trim() === 'View') {
        btn.click();
        return;
      }
    }
  });

  // Wait for modal to appear
  const modal = page.locator('[data-testid="process-modal"]');
  await expect(modal).toBeVisible({ timeout: 5_000 });

  // Screenshot: modal should be open with flowchart
  await page.screenshot({ path: testInfo.outputPath('debug-modal-open.png'), fullPage: true });

  // Get the diagram's current transform
  const diagramDiv = modal.locator('[style*="transform"]');
  const transformBefore = await diagramDiv.getAttribute('style');
  console.log('Transform BEFORE zoom:', transformBefore);

  // Zoom in using the + button
  const zoomInBtn = modal.getByRole('button', { name: /Zoom in/ });
  await zoomInBtn.click();
  await zoomInBtn.click();
  await zoomInBtn.click();
  // Wait for zoom animation to settle
  await expect(async () => {
    const t = await diagramDiv.getAttribute('style');
    expect(t).not.toBe(transformBefore);
  }).toPass({ timeout: 2_000 });

  const transformAfterZoom = await diagramDiv.getAttribute('style');
  console.log('Transform AFTER zoom:', transformAfterZoom);
  await page.screenshot({ path: testInfo.outputPath('debug-modal-zoomed.png'), fullPage: true });

  // Click Reset View
  const resetBtn = modal.getByRole('button', { name: 'Reset View' });
  await resetBtn.click();
  // Wait for reset animation to settle
  await expect(async () => {
    const t = await diagramDiv.getAttribute('style');
    expect(t).toBe(transformBefore);
  }).toPass({ timeout: 2_000 });

  const transformAfterReset = await diagramDiv.getAttribute('style');
  console.log('Transform AFTER reset:', transformAfterReset);
  await page.screenshot({
    path: testInfo.outputPath('debug-modal-after-reset.png'),
    fullPage: true,
  });

  // Verify transform actually changed back
  expect(transformAfterZoom).not.toBe(transformBefore);
  expect(transformAfterReset).toBe(transformBefore);
});

debugTest('debug: lightbulb clears node selection dimming', async ({ page }, testInfo) => {
  await connectToServer(page);

  // Wait for graph canvas to render
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: testInfo.outputPath('debug-before-select.png'), fullPage: true });

  // Click a file in the tree to select a node (causes dimming)
  const fileItem = page.getByText('start.sh');
  await fileItem.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath('debug-node-selected.png'), fullPage: true });

  // Check the lightbulb button state
  const lightbulbBtn = page.locator('button[title*="Turn off"], button[title*="Turn on"]');
  const title = await lightbulbBtn.getAttribute('title');
  console.log('Lightbulb title before click:', title);

  // Click the lightbulb
  await lightbulbBtn.click();
  await page.waitForTimeout(500);

  const titleAfter = await lightbulbBtn.getAttribute('title');
  console.log('Lightbulb title after click:', titleAfter);
  await page.screenshot({ path: testInfo.outputPath('debug-after-lightbulb.png'), fullPage: true });

  // Click it again to toggle back on
  await lightbulbBtn.click();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: testInfo.outputPath('debug-after-lightbulb-toggle-back.png'),
    fullPage: true,
  });
});
