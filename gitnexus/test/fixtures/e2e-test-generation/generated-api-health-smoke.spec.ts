import { test, expect } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';

const apiUrl = (path: string): string => new URL(path, BACKEND_URL).toString();

test.describe('Generated GitNexus API smoke plan: Exercise route /api/health after impacted API change', () => {
  test('route /api/health returns the stable healthcheck JSON contract', async ({ request }) => {
    const response = await request.get(apiUrl('/api/health'));

    expect(response.ok()).toBeTruthy();

    const body: unknown = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        status: 'ok',
      }),
    );
  });
});
