import { test, expect } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const REPO = process.env.GITNEXUS_REPO;

const apiUrl = (path: string): string => {
  const url = new URL(path, BACKEND_URL);
  if (REPO) url.searchParams.set('repo', REPO);
  return url.toString();
};

test.describe('Generated GitNexus API smoke plan: Exercise route /api/process after impacted API change', () => {
  test('route /api/process uses an explicit list-to-detail strategy and returns the stable process-detail JSON shape', async ({ request }) => {
    const listResponse = await request.get(apiUrl('/api/processes'));

    expect(listResponse.ok()).toBeTruthy();

    const listBody: unknown = await listResponse.json();
    expect(listBody).toEqual(
      expect.objectContaining({
        processes: expect.any(Array),
      }),
    );

    const processes = (listBody as { processes: Array<Record<string, unknown>> }).processes;
    const firstProcess = processes[0];
    expect(firstProcess).toBeDefined();

    const selectedName = String(firstProcess.heuristicLabel ?? firstProcess.label ?? '').trim();
    expect(selectedName).not.toBe('');

    const detailResponse = await request.get(apiUrl(`/api/process?name=${encodeURIComponent(selectedName)}`));

    expect(detailResponse.ok()).toBeTruthy();

    const detailBody: unknown = await detailResponse.json();
    expect(detailBody).toEqual(
      expect.objectContaining({
        process: expect.objectContaining({
          id: expect.any(String),
          label: expect.any(String),
          heuristicLabel: expect.any(String),
          processType: expect.any(String),
          stepCount: expect.any(Number),
        }),
        steps: expect.any(Array),
      }),
    );

    const payload = detailBody as { steps: unknown[] };
    for (const step of payload.steps) {
      expect(step).toEqual(
        expect.objectContaining({
          step: expect.any(Number),
          name: expect.any(String),
          type: expect.any(String),
        }),
      );
    }
  });
});
