import { test, expect } from '@playwright/test';

/**
 * E2E tests for heartbeat disconnect/reconnect behavior.
 *
 * Verifies the key regression: when the heartbeat fails, the UI shows a
 * "reconnecting" banner instead of resetting to the onboarding screen.
 *
 * Strategy: block /api/heartbeat via route interception BEFORE loading the
 * graph. The heartbeat EventSource can never connect, so onReconnecting
 * fires on the first retry attempt. This reliably tests the banner behavior
 * without depending on setOffline timing (which varies across CI environments).
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
    }
  } catch {
    test.skip(true, 'servers not available');
  }
});

test.describe('Heartbeat Reconnect', () => {
  test('shows reconnecting banner instead of onboarding reset when heartbeat is unavailable', async ({
    page,
  }) => {
    // Block the heartbeat BEFORE navigating — the EventSource will fail
    // immediately on every connection attempt, triggering onReconnecting.
    await page.route('**/api/heartbeat', (route) => route.abort('connectionrefused'));

    // Load the app and connect to a repo (all other endpoints work normally)
    await page.goto('/');

    const landingCard = page.locator('[data-testid="landing-repo-card"]').first();
    try {
      await landingCard.waitFor({ state: 'visible', timeout: 15_000 });
      await landingCard.click();
    } catch {
      // auto-connect may skip the landing screen
    }

    // Wait for graph to load (heartbeat is blocked, but graph loads fine)
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });

    // The reconnecting banner should appear (heartbeat is failing)
    const banner = page.getByText('Server connection lost');
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // The graph canvas should STILL be visible — NOT reset to onboarding
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('banner clears when heartbeat becomes available', async ({ page }) => {
    // Start with heartbeat blocked
    await page.route('**/api/heartbeat', (route) => route.abort('connectionrefused'));

    await page.goto('/');
    const landingCard = page.locator('[data-testid="landing-repo-card"]').first();
    try {
      await landingCard.waitFor({ state: 'visible', timeout: 15_000 });
      await landingCard.click();
    } catch {
      // auto-connect may skip the landing screen
    }

    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });

    // Verify banner appears
    const banner = page.getByText('Server connection lost');
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // Unblock heartbeat — the real server is running, so reconnect will succeed
    await page.unroute('**/api/heartbeat');

    // Banner should disappear as heartbeat reconnects
    await expect(banner).not.toBeVisible({ timeout: 30_000 });

    // Graph should still be there
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible();
  });
});
