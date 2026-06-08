import { test, expect } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const REPO = process.env.GITNEXUS_REPO;

const apiUrl = (path: string): string => {
  const url = new URL(path, BACKEND_URL);
  if (REPO) url.searchParams.set('repo', REPO);
  return url.toString();
};

test.describe('Generated GitNexus API smoke plan: Exercise route /api/cluster after impacted API change', () => {
  test('route /api/cluster uses an explicit list-to-detail strategy and returns the stable cluster-detail JSON shape', async ({ request }) => {
    const listResponse = await request.get(apiUrl('/api/clusters'));

    expect(listResponse.ok()).toBeTruthy();

    const listBody: unknown = await listResponse.json();
    expect(listBody).toEqual(
      expect.objectContaining({
        clusters: expect.any(Array),
      }),
    );

    const clusters = (listBody as { clusters: Array<Record<string, unknown>> }).clusters;
    const firstCluster = clusters[0];
    expect(firstCluster).toBeDefined();

    const selectedName = String(firstCluster.heuristicLabel ?? firstCluster.label ?? '').trim();
    expect(selectedName).not.toBe('');

    const detailResponse = await request.get(apiUrl(`/api/cluster?name=${encodeURIComponent(selectedName)}`));

    expect(detailResponse.ok()).toBeTruthy();

    const detailBody: unknown = await detailResponse.json();
    expect(detailBody).toEqual(
      expect.objectContaining({
        cluster: expect.objectContaining({
          id: expect.any(String),
          label: expect.any(String),
          heuristicLabel: expect.any(String),
          cohesion: expect.any(Number),
          symbolCount: expect.any(Number),
          subCommunities: expect.any(Number),
        }),
        members: expect.any(Array),
      }),
    );

    const payload = detailBody as { members: unknown[] };
    for (const member of payload.members) {
      expect(member).toEqual(
        expect.objectContaining({
          name: expect.any(String),
          type: expect.any(String),
          filePath: expect.any(String),
        }),
      );
    }
  });
});
