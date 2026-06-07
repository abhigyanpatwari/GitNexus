import { test, expect } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const REPO = process.env.GITNEXUS_REPO;

const apiUrl = (path: string): string => {
  const url = new URL(path, BACKEND_URL);
  if (REPO) url.searchParams.set('repo', REPO);
  return url.toString();
};

test.describe('Generated GitNexus API smoke plan: Exercise route /api/processes after impacted API change', () => {
  test('route /api/processes returns a JSON process list', async ({ request }) => {
    const response = await request.get(apiUrl('/api/processes'));

    expect(response.ok()).toBeTruthy();

    const body: unknown = await response.json();
    expect(Array.isArray(body)).toBe(true);

    for (const process of body) {
      expect(process).toEqual(
        expect.objectContaining({
          name: expect.any(String),
        }),
      );
    }
  });
});
