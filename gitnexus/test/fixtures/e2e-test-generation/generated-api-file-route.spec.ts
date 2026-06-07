import { test, expect } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';

test.describe('Generated E2E plan: Exercise route /api/file after impacted API change', () => {
  test('route /api/file exposes selected source content through mocked backend data', async ({ page }) => {
    await page.route(`${BACKEND_URL}/api/repos`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'generated-fixture-repo', path: '/tmp/generated-fixture-repo' }]),
      }),
    );

    await page.route(`${BACKEND_URL}/api/repo`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'generated-fixture-repo',
          path: '/tmp/generated-fixture-repo',
          repoPath: '/tmp/generated-fixture-repo',
          stats: {
            files: 7,
            nodes: 2,
            edges: 1,
            processes: 3,
          },
        }),
      }),
    );

    await page.route(`${BACKEND_URL}/api/graph**`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          nodes: [
            {
              id: 'File:src/index.ts',
              label: 'File',
              properties: {
                name: 'index.ts',
                filePath: 'src/index.ts',
                language: 'typescript',
              },
            },
            {
              id: 'Function:src/index.ts:generatedFixture',
              label: 'Function',
              properties: {
                name: 'generatedFixture',
                filePath: 'src/index.ts',
                language: 'typescript',
                startLine: 1,
                endLine: 3,
              },
            },
          ],
          relationships: [
            {
              id: 'Relationship:src/index.ts:generatedFixture',
              sourceId: 'File:src/index.ts',
              targetId: 'Function:src/index.ts:generatedFixture',
              type: 'CONTAINS',
              confidence: 1,
              reason: 'generated fixture',
            },
          ],
        }),
      }),
    );

    await page.route(`${BACKEND_URL}/api/file**`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          content: 'export const generatedFixture = () => {\n  return "file-route-fixture";\n};\n',
          startLine: 0,
          endLine: 3,
          totalLines: 3,
        }),
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
    await page.getByText('index.ts').first().click();

    await expect(page.getByText('export const generatedFixture')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('file-route-fixture')).toBeVisible();
  });
});
