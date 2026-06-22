import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedTerminal {
  cursorTo(x?: number | null, y?: number | null): void;
  lineWrapping(enabled: boolean): void;
  clearRight(): void;
  newline(): void;
  write(s: string, rawWrite?: boolean): void;
  isTTY(): boolean;
}

interface CapturedBarOptions {
  noTTYOutput?: boolean;
  notTTYSchedule?: number;
  terminal?: CapturedTerminal;
}

const mocks = vi.hoisted(() => ({
  runFullAnalysisMock: vi.fn(),
  capturedBarOptions: [] as CapturedBarOptions[],
}));

vi.mock('cli-progress', () => ({
  default: {
    SingleBar: vi.fn(function (options: CapturedBarOptions) {
      mocks.capturedBarOptions.push(options);
      return {
        start: vi.fn(),
        update: vi.fn(),
        stop: vi.fn(),
      };
    }),
    Presets: { shades_grey: {} },
  },
}));

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: mocks.runFullAnalysisMock,
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
  closeLbugBeforeExit: vi.fn(async () => undefined),
  isLbugReady: vi.fn(() => false),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: vi.fn(() => ({ storagePath: '.gitnexus', lbugPath: '.gitnexus/lbug' })),
  getGlobalRegistryPath: vi.fn(() => 'registry.json'),
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
  AnalysisNotFinalizedError: class AnalysisNotFinalizedError extends Error {},
  assertAnalysisFinalized: vi.fn(async () => undefined),
}));

vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: vi.fn(() => '/repo'),
  hasGitDir: vi.fn(() => true),
}));

vi.mock('../../src/core/ingestion/utils/max-file-size.js', () => ({
  getMaxFileSizeBannerMessage: vi.fn(() => null),
}));

const setStreamIsTTY = (stream: NodeJS.WriteStream, value: boolean): (() => void) => {
  const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  Object.defineProperty(stream, 'isTTY', { configurable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else delete (stream as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
  };
};

describe('analyzeCommand respawn progress terminal bridge', () => {
  const ORIGINAL_NODE_OPTIONS = process.env.NODE_OPTIONS;
  const ORIGINAL_RESPAWN_PROGRESS = process.env.GITNEXUS_RESPAWN_PROGRESS_TTY;
  const ORIGINAL_COLUMNS = process.env.COLUMNS;
  let restoreStderrIsTTY: (() => void) | undefined;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mocks.runFullAnalysisMock.mockReset();
    mocks.capturedBarOptions.length = 0;
    mocks.runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = '--max-old-space-size=8192';
    process.env.GITNEXUS_RESPAWN_PROGRESS_TTY = '1';
    restoreStderrIsTTY = setStreamIsTTY(process.stderr, false);
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    restoreStderrIsTTY?.();
    restoreStderrIsTTY = undefined;
    if (ORIGINAL_NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = ORIGINAL_NODE_OPTIONS;
    if (ORIGINAL_RESPAWN_PROGRESS === undefined) delete process.env.GITNEXUS_RESPAWN_PROGRESS_TTY;
    else process.env.GITNEXUS_RESPAWN_PROGRESS_TTY = ORIGINAL_RESPAWN_PROGRESS;
    if (ORIGINAL_COLUMNS === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = ORIGINAL_COLUMNS;
  });

  it('uses an ANSI terminal shim instead of cli-progress non-TTY newline mode', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(mocks.capturedBarOptions).toHaveLength(1);
    const options = mocks.capturedBarOptions[0];
    expect(options.noTTYOutput).toBeUndefined();
    expect(options.notTTYSchedule).toBeUndefined();
    expect(options.terminal).toBeDefined();
    expect(options.terminal.isTTY()).toBe(true);

    options.terminal.cursorTo(0, null);
    options.terminal.clearRight();
    options.terminal.newline();
    expect(stderrWriteSpy).toHaveBeenCalledWith('\r');
    expect(stderrWriteSpy).toHaveBeenCalledWith('\x1B[0K');
    expect(stderrWriteSpy).toHaveBeenCalledWith('\n');
  });

  it('truncates wrapped progress writes without splitting ANSI escapes or surrogate pairs', async () => {
    process.env.COLUMNS = '3';
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    const options = mocks.capturedBarOptions[0];
    options.terminal.write('ab\x1B[31mcd');
    expect(stderrWriteSpy).toHaveBeenLastCalledWith('ab\x1B[31mc');

    process.env.COLUMNS = '4';
    options.terminal.write('abc😀def');
    expect(stderrWriteSpy).toHaveBeenLastCalledWith('abc');

    options.terminal.write('abc😀def', true);
    expect(stderrWriteSpy).toHaveBeenLastCalledWith('abc😀def');
  });
});
