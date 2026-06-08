import { test, expect } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const REPO = process.env.GITNEXUS_REPO;

const apiUrl = (path: string): string => {
  const url = new URL(path, BACKEND_URL);
  if (REPO) url.searchParams.set('repo', REPO);
  return url.toString();
};

test.describe('Generated GitNexus API smoke plan: Exercise route /api/clusters after impacted API change', () => {
  test('route /api/clusters returns the stable clusters JSON shape', async ({ request }) => {
    const response = await request.get(apiUrl('/api/clusters'));

    expect(response.ok()).toBeTruthy();

    const body: unknown = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        clusters: expect.any(Array),
      }),
    );

    const payload = body as { clusters: unknown[] };
    for (const cluster of payload.clusters) {
      expect(cluster).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          heuristicLabel: expect.any(String),
          symbolCount: expect.any(Number),
        }),
      );
    }
  });
});
