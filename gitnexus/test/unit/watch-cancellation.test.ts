import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ analyze: vi.fn(), mayEmbed: vi.fn(async () => false) }));
vi.mock('../../src/cli/analyze.js', () => ({
  ensureHeap: vi.fn(async () => false),
  usesManualAnalysisHeap: () => false,
}));
vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: mocks.analyze,
  analyzeFailureMayHaveMutatedLiveIndex: () => false,
}));
vi.mock('../../src/core/analysis-host-resources.js', () => ({
  analysisMayEmbed: mocks.mayEmbed,
  analysisSupervisorReservation: () => 192 * 1024 ** 2,
  resolveHostAnalysisResources: () => ({ mainHeapMb: 512 }),
}));
import { watchCommandWithRunnerIdentity } from '../../src/cli/analyze-watch.js';
import type { AnalyzerRunnerIdentity } from '../../src/storage/repo-manager.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mocks.analyze.mockReset();
  mocks.mayEmbed.mockReset();
  mocks.mayEmbed.mockResolvedValue(false);
});

it.each(['preflight', 'analysis'] as const)(
  'consumes supervisor cancellation during %s and waits for active work',
  async (phase) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-watch-cancel-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.spyOn(process, 'send').mockImplementation(() => true);
    const listeners = process.listeners('message');
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (phase === 'preflight')
      mocks.mayEmbed.mockImplementationOnce(async () => {
        await held;
        return false;
      });
    mocks.analyze.mockImplementation(async () => {
      await held;
      return { alreadyUpToDate: true };
    });
    let settled = false;
    const run = watchCommandWithRunnerIdentity(
      { schemaVersion: 4 } as AnalyzerRunnerIdentity,
      repo,
    ).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() =>
        expect(phase === 'preflight' ? mocks.mayEmbed : mocks.analyze).toHaveBeenCalled(),
      );
      const control = process
        .listeners('message')
        .find((listener) => !listeners.includes(listener));
      expect(control).toBeDefined();
      control!({ type: 'cancel' }, undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      finish();
      await run;
      expect(process.listeners('message')).not.toContain(control);
      expect(mocks.analyze).toHaveBeenCalledTimes(phase === 'preflight' ? 0 : 1);
    } finally {
      finish();
      await run;
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
