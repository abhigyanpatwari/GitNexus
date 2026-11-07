import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resources: vi.fn((_request: { supervisorBytes?: number }) => ({
    mainHeapMb: 512,
    supervisorBytes: 0,
  })),
  heap: vi.fn(async () => true),
  storage: vi.fn(async (_repo: string): Promise<string> => {
    throw new Error('stop after admission');
  }),
  analyze: vi.fn(async () => ({ alreadyUpToDate: true })),
}));
vi.mock('../../src/cli/analyze.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/analyze.js')>();
  return { ensureHeap: mocks.heap, usesManualAnalysisHeap: actual.usesManualAnalysisHeap };
});
vi.mock('../../src/storage/storage-resolver.js', () => ({
  ANALYZE_STORAGE_REQUIREMENTS: {},
  requireStoragePath: mocks.storage,
}));
vi.mock('../../src/core/analysis-host-resources.js', () => ({
  analysisMayEmbed: async () => false,
  analysisSupervisorReservation: () => 192 * 1024 ** 2,
  resolveHostAnalysisResources: mocks.resources,
}));
vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: mocks.analyze,
  analyzeFailureMayHaveMutatedLiveIndex: () => false,
}));
import {
  resolveWatchOptions,
  watchCommandWithRunnerIdentity,
} from '../../src/cli/analyze-watch.js';
import type { AnalyzerRunnerIdentity } from '../../src/storage/repo-manager.js';

const directories: string[] = [];
beforeEach(() => {
  mocks.resources.mockReturnValue({ mainHeapMb: 512, supervisorBytes: 0 });
  vi.stubEnv('GITNEXUS_ANALYSIS_MAIN_HEAP_MB', undefined);
  vi.stubEnv('GITNEXUS_ANALYSIS_SUPERVISOR_BYTES', undefined);
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

it('keeps the admitted heap across real watch refreshes and restores it on exit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-watch-admitted-'));
  directories.push(directory);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: directory, stdio: 'pipe' });
  vi.stubEnv('GITNEXUS_RC', '');
  mocks.resources.mockReturnValue({ mainHeapMb: 1024, supervisorBytes: 192 * 1024 ** 2 });
  mocks.heap.mockResolvedValueOnce(false);
  mocks.storage.mockResolvedValueOnce(path.join(directory, '.gitnexus'));
  const listeners = process.listeners('message');
  const run = watchCommandWithRunnerIdentity({} as AnalyzerRunnerIdentity, directory, {
    debounce: '10',
  });
  const control = process.listeners('message').find((listener) => !listeners.includes(listener));
  try {
    expect(control).toBeDefined();
    await vi.waitFor(() => expect(mocks.analyze).toHaveBeenCalledOnce());
    await fs.writeFile(path.join(directory, '.gitnexusrc'), JSON.stringify({ workers: 1 }));
    await vi.waitFor(() => expect(mocks.analyze).toHaveBeenCalledTimes(2));
    expect(mocks.resources.mock.calls[0][0]).toMatchObject({ mainHeapMb: undefined });
    expect(mocks.resources.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [request] of mocks.resources.mock.calls.slice(1))
      expect(request).toMatchObject({ mainHeapMb: 1024 });
    expect(process.env.GITNEXUS_ANALYSIS_MAIN_HEAP_MB).toBe('1024');
  } finally {
    control?.({ type: 'cancel' }, undefined);
    await run;
  }
  expect(process.env.GITNEXUS_ANALYSIS_MAIN_HEAP_MB).toBeUndefined();
  expect(process.env.GITNEXUS_ANALYSIS_SUPERVISOR_BYTES).toBeUndefined();
});
