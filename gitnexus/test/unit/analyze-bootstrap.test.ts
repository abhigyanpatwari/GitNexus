import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  check: vi.fn(() => ({ ok: true })),
  analyze: vi.fn(),
  analyzeOrWatch: vi.fn(),
}));

vi.mock('../../src/core/analyzer-identity.js', () => ({
  captureAnalyzerIdentityBeforeLoad: mocks.capture,
}));
vi.mock('../../src/core/lbug/native-check.js', () => ({
  prepareLbugNativeBinary: vi.fn(),
  checkLbugNative: mocks.check,
}));
vi.mock('../../src/cli/analyze.js', () => ({
  analyzeCommand: mocks.analyze,
  analyzeOrWatchCommandWithRunnerIdentity: mocks.analyzeOrWatch,
}));
vi.mock('../../src/cli/update-notice.js', () => ({ runProcessCliUpdateNotice: vi.fn() }));

const originalArgv = process.argv;
const connected = Object.getOwnPropertyDescriptor(process, 'connected');
const receipt = { schemaVersion: 4 };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.capture.mockImplementation(async (_url, loader) => ({
    runnerIdentity: receipt,
    loaded: await loader(),
  }));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // Vitest's fork also owns IPC. Keep it connected while exercising the CLI
  // dispatcher, so its own result channel is not disrupted by this fixture.
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
});

afterEach(() => {
  process.argv = originalArgv;
  if (connected) Object.defineProperty(process, 'connected', connected);
  else delete (process as Partial<NodeJS.Process>).connected;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { continuation: false, watch: false, captures: true },
  { continuation: false, watch: true, captures: true },
  { continuation: true, watch: false, captures: false },
])('selects the analyzer bootstrap for %j', async (scenario) => {
  vi.stubEnv('GITNEXUS_ANALYSIS_CONTINUATION', scenario.continuation ? '1' : '');
  process.argv = [process.execPath, 'gitnexus', 'analyze', '/fixture'];
  if (scenario.watch) process.argv.push('--watch');

  await import('../../src/cli/index.js');
  if (scenario.captures) {
    await vi.waitFor(() => expect(mocks.analyzeOrWatch).toHaveBeenCalledOnce());
    expect(mocks.analyzeOrWatch).toHaveBeenCalledWith(
      receipt,
      '/fixture',
      expect.objectContaining(scenario.watch ? { watch: true } : {}),
    );
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.analyze).not.toHaveBeenCalled();
  } else {
    await vi.waitFor(() => expect(mocks.analyze).toHaveBeenCalledOnce());
    expect(mocks.analyze).toHaveBeenCalledWith('/fixture', expect.any(Object));
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.analyzeOrWatch).not.toHaveBeenCalled();
  }
  expect(mocks.check).toHaveBeenCalledOnce();
});
