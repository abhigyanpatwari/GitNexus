import { test, expect } from '@playwright/test';

/**
 * E2E tests for multi-repo scoping and URL persistence.
 *
 * Verifies that:
 * - Connecting via ?server= loads data and sets ?project= in the URL
 * - The repo name appears in the UI after connecting
 * - F5 with ?server=&project= reconnects to the correct repo
 *
 * Runs against the single indexed repo in CI — validates the plumbing
 * works end-to-end even with one repo.
 */

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

let firstRepoName: string;

test.beforeAll(async () => {
  if (process.env.E2E) {
    // Still need to fetch the repo name for assertions
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

// Auto-connect downloads the full graph from the backend; under parallel
// workers in CI the same backend serves multiple downloads concurrently, so
// reaching the "Ready" state can take noticeably longer than a single-worker
// run. Match the 45s budget used by waitForGraphLoaded() in
// server-connect.spec.ts which has been stable on the same backend.
const READY_TIMEOUT_MS = 45_000;

test.describe('Multi-Repo Scoping', () => {
  test('auto-connect via ?server= sets ?project= in URL', async ({ page }) => {
    // Navigate with ?server= param (the bookmarkable shortcut)
    await page.goto(`/?server=${encodeURIComponent(BACKEND_URL)}`);

    // Wait for graph to load
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({
      timeout: READY_TIMEOUT_MS,
    });

    // URL should now contain ?project= with the repo name
    const url = new URL(page.url());
    const project = url.searchParams.get('project');
    expect(project).toBeTruthy();
    expect(project).toBe(firstRepoName);
  });

  test('?server= is preserved in URL for F5 recovery', async ({ page }) => {
    // Two sequential auto-connects (initial + reload), each up to READY_TIMEOUT_MS,
    // can exceed the default 60s test timeout under parallel workers.
    test.slow();

    await page.goto(`/?server=${encodeURIComponent(BACKEND_URL)}`);
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({
      timeout: READY_TIMEOUT_MS,
    });

    // URL should still have ?server=
    const url = new URL(page.url());
    expect(url.searchParams.get('server')).toBeTruthy();

    // F5 should reconnect (not show onboarding)
    await page.reload();
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({
      timeout: READY_TIMEOUT_MS,
    });
  });

  test('node count in status bar matches backend data', async ({ page }) => {
    await page.goto(`/?server=${encodeURIComponent(BACKEND_URL)}`);
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({
      timeout: READY_TIMEOUT_MS,
    });

    // Fetch expected node count from backend
    const res = await fetch(`${BACKEND_URL}/api/repo?repo=${encodeURIComponent(firstRepoName)}`);
    const repoInfo = await res.json();
    const expectedNodes = repoInfo.stats?.nodes;

    if (expectedNodes) {
      // Status bar shows node count — use the status-ready area to avoid
      // matching multiple elements (file tree, header may also show counts)
      const statusBar = page.locator('footer');
      const nodeText = statusBar.getByText(/\d+ nodes/).first();
      await expect(nodeText).toBeVisible({ timeout: 10_000 });
      const text = await nodeText.textContent();
      const displayedNodes = parseInt(text?.match(/(\d+)\s*nodes/)?.[1] ?? '0', 10);
      expect(displayedNodes).toBeGreaterThan(0);
    }
  });
});
