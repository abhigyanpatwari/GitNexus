import { test, expect } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';

test.describe('Generated E2E plan: Exercise route /api/repo after impacted API change', () => {
  test('route /api/repo exposes selected repo metadata through mocked backend data', async ({ page }) => {
    await page.route(`${BACKEND_URL}/api/repos`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'generated-fixture-repo', path: '/tmp/generated-fixture-repo' }]),
      }),
    );

    await page.route(
      (url) => url.origin === BACKEND_URL && url.pathname === '/api/repo',
      (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            name: 'generated-fixture-repo',
            path: '/tmp/generated-fixture-repo',
            repoPath: '/tmp/generated-fixture-repo',
            stats: {
              files: 7,
              nodes: 42,
              edges: 64,
              processes: 3,
            },
          }),
        }),
    );

    await page.route(`${BACKEND_URL}/api/graph**`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ nodes: [], relationships: [] }),
      }),
    );

    await page.route(`${BACKEND_URL}/api/heartbeat`, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: ':ok\n\n',
      }),
    );

    await page.goto('/');

    await expect(page.getByText('generated-fixture-repo')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('contentinfo').getByTestId('graph-stats')).toContainText('42 nodes');
  });
});
