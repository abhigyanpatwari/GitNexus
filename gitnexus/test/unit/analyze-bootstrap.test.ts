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
const originalExecArgv = process.execArgv;
const connected = Object.getOwnPropertyDescriptor(process, 'connected');
const receipt = { schemaVersion: 4 };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.execArgv = [];
  for (const key of [
    'GITNEXUS_ANALYSIS_SUPERVISED',
    'GITNEXUS_ANALYSIS_MANUAL_HEAP',
    'GITNEXUS_MEMORY',
    'GITNEXUS_TEST_RESPAWN_HEAP_MB',
    'NODE_OPTIONS',
  ])
    vi.stubEnv(key, undefined);
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
  process.execArgv = originalExecArgv;
  if (connected) Object.defineProperty(process, 'connected', connected);
  else delete (process as Partial<NodeJS.Process>).connected;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each<{
  continuation?: boolean;
  watch?: boolean;
  budget?: boolean;
  source?: string;
  env?: Record<string, string>;
  execArgv?: string[];
  captures: boolean;
}>([
  { continuation: false, watch: false, budget: false, source: '', captures: false },
  { continuation: false, watch: true, budget: false, source: '', captures: true },
  { continuation: true, watch: false, budget: false, source: '', captures: false },
  { continuation: false, watch: false, budget: true, source: '', captures: false },
  { continuation: false, watch: false, budget: true, source: 'auto', captures: false },
  { continuation: false, watch: false, budget: true, source: 'budget', captures: true },
  { continuation: false, watch: true, budget: true, source: '', captures: true },
  { env: { GITNEXUS_ANALYSIS_SUPERVISED: '1' }, captures: true },
  { env: { GITNEXUS_ANALYSIS_MANUAL_HEAP: '1' }, captures: true },
  { env: { GITNEXUS_MEMORY: 'off' }, captures: true },
  { env: { GITNEXUS_TEST_RESPAWN_HEAP_MB: '128' }, captures: true },
  { env: { NODE_OPTIONS: '--max_old_space_size=2048' }, captures: true },
  { execArgv: ['--max-old-space-size=2048'], captures: true },
])('selects the analyzer bootstrap for %j', async (scenario) => {
  vi.stubEnv('GITNEXUS_ANALYSIS_CONTINUATION', scenario.continuation ? '1' : '');
  vi.stubEnv('GITNEXUS_HEAP_LIMIT_SOURCE', scenario.source ?? '');
  for (const [key, value] of Object.entries(scenario.env ?? {})) vi.stubEnv(key, value);
  if (scenario.execArgv) process.execArgv = scenario.execArgv;
  process.argv = [process.execPath, 'gitnexus', 'analyze', '/fixture'];
  if (scenario.watch) process.argv.push('--watch');
  if (scenario.budget) process.argv.push('--memory-budget', '2048');

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
