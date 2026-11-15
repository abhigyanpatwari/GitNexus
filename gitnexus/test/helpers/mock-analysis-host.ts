import { vi } from 'vitest';

// CLI option/error tests mock the analysis itself. Keep admission independent
// of the test worker's growing coverage heap and the machine running Vitest.
// Resource-policy tests deliberately do not import this fixture.
const DEFAULT_HOST = { ramBytes: 32 * 1024 ** 3, heapLimitBytes: 1024 ** 3 };

/** The mocked host. A test may change it and must call `resetAnalysisHost`. */
export const analysisHost = { ...DEFAULT_HOST };
export const resetAnalysisHost = (): void => void Object.assign(analysisHost, DEFAULT_HOST);

vi.mock('node:v8', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:v8')>();
  const mocked = {
    ...actual,
    getHeapStatistics: () => ({
      ...actual.getHeapStatistics(),
      heap_size_limit: analysisHost.heapLimitBytes,
    }),
  };
  return { ...mocked, default: mocked };
});

vi.mock('../../src/core/ingestion/utils/effective-ram.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/ingestion/utils/effective-ram.js')>()),
  effectiveRamBytes: () => analysisHost.ramBytes,
}));

vi.mock('../../src/core/analysis-host-resources.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/analysis-host-resources.js')>()),
  analysisSupervisorReservation: () => 192 * 1024 ** 2,
}));
