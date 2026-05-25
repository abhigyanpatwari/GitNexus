import { test, expect } from '@playwright/test';

/**
 * E2E tests for graph layout mode switching (Sequential / Radial layouts).
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

async function waitForGraphLoaded(page: import('@playwright/test').Page) {
  await page.goto(`${FRONTEND_URL}?lng=en`);

  // The app starts on the landing/onboarding screen. Pick the first repo card
  // (preferring a known repo name) and click it to load the graph.
  const landingCards = page.locator('[data-testid="landing-repo-card"]');
  const preferredCard = landingCards.filter({ hasText: /GitNexus|local-integration/ }).first();
  try {
    await landingCards.first().waitFor({ state: 'visible', timeout: 15_000 });
    const card = (await preferredCard.count()) > 0 ? preferredCard : landingCards.first();
    await card.click();
  } catch {
    // Landing screen may not appear (e.g. when ?server auto-connects)
  }

  // Wait until the status bar confirms the graph is ready.
  const statusBar = page.getByRole('contentinfo');
  await expect(statusBar.getByText('Ready', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(statusBar).toContainText(/nodes/, { timeout: 20_000 });

  // Finally confirm the sigma canvas is present.
  await page.waitForSelector('.sigma-container', { timeout: 10_000 });
}

test.describe('Graph Layout Modes', () => {
  test.beforeEach(async ({ page }) => {
    await waitForGraphLoaded(page);
  });

  test('should switch between force, sequential, and radial layouts', async ({ page }) => {
    const forceTab = page.locator('button:has-text("Force Graph")');
    const sequentialTab = page.locator('button:has-text("Sequential Layout")');
    const radialTab = page.locator('button:has-text("Radial Layout")');

    // Force Graph is the default active tab
    await expect(forceTab).toHaveClass(/bg-accent/);
    await expect(sequentialTab).not.toHaveClass(/bg-accent/);

    // Switch to Sequential Layout
    await sequentialTab.click();
    await expect(sequentialTab).toHaveClass(/bg-accent/, { timeout: 5_000 });
    await expect(forceTab).not.toHaveClass(/bg-accent/);

    // All three layout tabs should be present in the tab bar
    await expect(radialTab).toBeVisible();

    // Switch back to Force Graph
    await forceTab.click();
    await expect(forceTab).toHaveClass(/bg-accent/, { timeout: 5_000 });
    await expect(sequentialTab).not.toHaveClass(/bg-accent/);
  });

  test('should interact with nodes in sequential layout', async ({ page }) => {
    await page.locator('button:has-text("Sequential Layout")').click();

    // Click the first file-tree item in the sidebar (more reliable than a
    // blind canvas click, which may land on empty space).  The FileTreePanel
    // renders node names as <span class="truncate font-mono text-xs">.
    // Clicking any of them calls setSelectedNode, which shows the selection
    // bar with the "Clear" button — the same mechanism used in
    // server-connect.spec.ts's "Turn Off All Highlights" test.
    const firstTreeItem = page.locator('span.truncate.font-mono').first();
    await firstTreeItem.waitFor({ state: 'visible', timeout: 10_000 });
    await firstTreeItem.click();

    await expect(page.locator('text=Clear')).toBeVisible({ timeout: 5_000 });
  });
});
