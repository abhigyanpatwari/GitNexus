import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resources: vi.fn((_request: { supervisorBytes?: number }) => ({
    mainHeapMb: 512,
    supervisorBytes: 0,
  })),
  heap: vi.fn(async () => true),
}));
vi.mock('../../src/cli/analyze.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/analyze.js')>();
  return { ensureHeap: mocks.heap, usesManualAnalysisHeap: actual.usesManualAnalysisHeap };
});
vi.mock('../../src/storage/storage-resolver.js', () => ({
  ANALYZE_STORAGE_REQUIREMENTS: {},
  requireStoragePath: vi.fn(async () => {
    throw new Error('stop after admission');
  }),
}));
vi.mock('../../src/core/analysis-host-resources.js', () => ({
  analysisMayEmbed: async () => false,
  analysisSupervisorReservation: () => 192 * 1024 ** 2,
  resolveHostAnalysisResources: mocks.resources,
}));
import {
  resolveWatchOptions,
  watchCommandWithRunnerIdentity,
} from '../../src/cli/analyze-watch.js';
import type { AnalyzerRunnerIdentity } from '../../src/storage/repo-manager.js';

const directories: string[] = [];
beforeEach(() => {
  vi.stubEnv('GITNEXUS_MEMORY', '');
  vi.stubEnv('GITNEXUS_ANALYSIS_MANUAL_HEAP', '');
  vi.stubEnv('NODE_OPTIONS', '');
});
afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

it.each([undefined, String(320 * 1024 ** 2)])(
  'accounts for the supervisor before heap respawn with inherited reservation %s',
  async (inherited) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-watch-supervisor-'));
    directories.push(directory);
    await fs.mkdir(path.join(directory, '.git'));
    vi.stubEnv('GITNEXUS_ANALYSIS_SUPERVISOR_BYTES', inherited);
    await watchCommandWithRunnerIdentity({} as AnalyzerRunnerIdentity, directory);
    expect(mocks.resources).toHaveBeenCalledWith(
      expect.objectContaining({
        supervisorBytes: inherited === undefined ? 192 * 1024 ** 2 : Number(inherited),
      }),
    );
    expect(mocks.heap).toHaveBeenCalledOnce();
  },
);

it.each([
  [undefined, undefined],
  [String(320 * 1024 ** 2), undefined],
  [undefined, '768'],
  [String(320 * 1024 ** 2), '768'],
])(
  'retains supervisor %s and explicit heap %s across watch refreshes',
  async (inherited, memoryBudget) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-watch-supervisor-'));
    directories.push(directory);
    vi.stubEnv('GITNEXUS_ANALYSIS_SUPERVISOR_BYTES', inherited);
    vi.stubEnv('GITNEXUS_RC', '');
    const baseline = { maxFileSize: undefined, workerTimeout: undefined, verbose: undefined };
    await resolveWatchOptions(directory, { memoryBudget }, baseline);
    await resolveWatchOptions(directory, { memoryBudget }, baseline);
    expect(mocks.resources).toHaveBeenCalledTimes(2);
    for (const [request] of mocks.resources.mock.calls)
      expect(request).toMatchObject({
        supervisorBytes: inherited === undefined ? 192 * 1024 ** 2 : Number(inherited),
        mainHeapMb:
          memoryBudget === undefined
            ? Math.ceil(getHeapStatistics().heap_size_limit / 1024 ** 2)
            : Number(memoryBudget),
      });
  },
);

it('honors GITNEXUS_MEMORY=off in the actual watch admission path', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-watch-manual-'));
  directories.push(directory);
  await fs.mkdir(path.join(directory, '.git'));
  vi.stubEnv('GITNEXUS_MEMORY', 'off');
  await watchCommandWithRunnerIdentity({} as AnalyzerRunnerIdentity, directory);
  expect(mocks.heap).not.toHaveBeenCalled();
  expect(mocks.resources).toHaveBeenCalledWith(
    expect.objectContaining({
      mainHeapMb: Math.ceil(getHeapStatistics().heap_size_limit / 1024 ** 2),
    }),
  );
});
