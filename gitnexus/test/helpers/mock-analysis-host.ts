import { vi } from 'vitest';

// CLI option/error tests mock the analysis itself. Keep admission independent
// of the test worker's growing coverage heap and the machine running Vitest.
// Resource-policy tests deliberately do not import this fixture.
vi.mock('node:v8', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:v8')>();
  const mocked = {
    ...actual,
    getHeapStatistics: () => ({ ...actual.getHeapStatistics(), heap_size_limit: 1024 ** 3 }),
  };
  return { ...mocked, default: mocked };
});

vi.mock('../../src/core/ingestion/utils/effective-ram.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/ingestion/utils/effective-ram.js')>()),
  effectiveRamBytes: () => 32 * 1024 ** 3,
}));

vi.mock('../../src/core/analysis-host-resources.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/analysis-host-resources.js')>()),
  analysisSupervisorReservation: () => 192 * 1024 ** 2,
}));
