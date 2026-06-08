import { test, expect } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';

const apiUrl = (path: string): string => new URL(path, BACKEND_URL).toString();

test.describe('Generated GitNexus API smoke plan: Exercise route /api/info after impacted API change', () => {
  test('route /api/info returns the stable server-info JSON shape', async ({ request }) => {
    const response = await request.get(apiUrl('/api/info'));

    expect(response.ok()).toBeTruthy();

    const body: unknown = await response.json();
    expect(typeof body).toBe('object');
    expect(body).not.toBeNull();

    const info = body as Record<string, unknown>;
    expect(info.version).toEqual(expect.any(String));
    expect(['npx', 'global', 'local']).toContain(info.launchContext);
    expect(String(info.nodeVersion)).toMatch(/^v\d+\.\d+\.\d+/);
  });
});
