import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resources: vi.fn((_request: { supervisorBytes?: number }) => ({
    mainHeapMb: 512,
    supervisorBytes: 0,
  })),
  heap: vi.fn(async () => true),
}));
vi.mock('../../src/cli/analyze.js', () => ({ ensureHeap: mocks.heap }));
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
afterEach(async () => {
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

it('retains the parent reservation across watch refreshes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-watch-supervisor-'));
  directories.push(directory);
  vi.stubEnv('GITNEXUS_ANALYSIS_SUPERVISOR_BYTES', String(320 * 1024 ** 2));
  vi.stubEnv('GITNEXUS_RC', '');
  const baseline = { maxFileSize: undefined, workerTimeout: undefined, verbose: undefined };
  await resolveWatchOptions(directory, {}, baseline);
  await resolveWatchOptions(directory, {}, baseline);
  expect(mocks.resources).toHaveBeenCalledTimes(2);
  for (const [request] of mocks.resources.mock.calls)
    expect(request).toMatchObject({ supervisorBytes: 320 * 1024 ** 2 });
});
