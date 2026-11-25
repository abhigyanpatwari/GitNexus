import '../helpers/mock-analysis-host.js';
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
  format?: string;
  noTTYOutput?: boolean;
  notTTYSchedule?: number;
  clearOnComplete?: boolean;
  terminal?: CapturedTerminal;
}

const mocks = vi.hoisted(() => ({
  runFullAnalysisMock: vi.fn(),
  capturedBarOptions: [] as CapturedBarOptions[],
  barUpdate: vi.fn(),
}));

vi.mock('cli-progress', () => ({
  default: {
    SingleBar: vi.fn(function (options: CapturedBarOptions) {
      mocks.capturedBarOptions.push(options);
      return {
        start: vi.fn(),
        update: mocks.barUpdate,
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
  loadMeta: vi.fn(async () => null),
  getStoragePaths: vi.fn(() => ({
    storagePath: '.gitnexus',
    lbugPath: '.gitnexus/lbug',
    metaPath: '.gitnexus/gitnexus.json',
  })),
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

  it('still clears the bar line before a log line', async () => {
    mocks.runFullAnalysisMock.mockImplementation(async () => {
      console.log('a log line during analysis');
      return { repoName: 'repo', repoPath: '/repo', stats: {}, alreadyUpToDate: true };
    });
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(mocks.runFullAnalysisMock).toHaveBeenCalledTimes(1);
    expect(stdoutWriteSpy).toHaveBeenCalledWith('\x1b[2K\r');
  });
});

describe('analyzeCommand progress without a terminal (#1194)', () => {
  const ORIGINAL_NODE_OPTIONS = process.env.NODE_OPTIONS;
  const ORIGINAL_RESPAWN_PROGRESS = process.env.GITNEXUS_RESPAWN_PROGRESS_TTY;
  let restoreStderrIsTTY: (() => void) | undefined;
  let restoreStdoutIsTTY: (() => void) | undefined;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mocks.runFullAnalysisMock.mockReset();
    mocks.barUpdate.mockReset();
    mocks.capturedBarOptions.length = 0;
    // A log line during the run goes through the progress-aware console.
    mocks.runFullAnalysisMock.mockImplementation(async () => {
      console.log('a log line during analysis');
      return { repoName: 'repo', repoPath: '/repo', stats: {}, alreadyUpToDate: true };
    });
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = '--max-old-space-size=8192';
    delete process.env.GITNEXUS_RESPAWN_PROGRESS_TTY;
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    restoreStderrIsTTY?.();
    restoreStderrIsTTY = undefined;
    restoreStdoutIsTTY?.();
    restoreStdoutIsTTY = undefined;
    if (ORIGINAL_NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = ORIGINAL_NODE_OPTIONS;
    if (ORIGINAL_RESPAWN_PROGRESS === undefined) delete process.env.GITNEXUS_RESPAWN_PROGRESS_TTY;
    else process.env.GITNEXUS_RESPAWN_PROGRESS_TTY = ORIGINAL_RESPAWN_PROGRESS;
  });

  it('prints a plain progress line every ten seconds when stderr is not a terminal', async () => {
    restoreStderrIsTTY = setStreamIsTTY(process.stderr, false);
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(mocks.capturedBarOptions).toHaveLength(1);
    const options = mocks.capturedBarOptions[0];
    expect(options.noTTYOutput).toBe(true);
    expect(options.notTTYSchedule).toBe(10_000);
    expect(options.format).toBe('  {percentage}% | {phase}');
    // stop() would otherwise end the log on a blank line.
    expect(options.clearOnComplete).toBe(true);
    expect(options.terminal).toBeUndefined();
  });

  it('prints plain lines when stdout alone is a terminal and nothing is bridged', async () => {
    restoreStderrIsTTY = setStreamIsTTY(process.stderr, false);
    restoreStdoutIsTTY = setStreamIsTTY(process.stdout, true);
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    const options = mocks.capturedBarOptions[0];
    expect(options.noTTYOutput).toBe(true);
    expect(options.terminal).toBeUndefined();
    expect(stdoutWriteSpy).not.toHaveBeenCalledWith('\x1b[2K\r');
  });

  it('keeps escapes and line breaks in a file name out of the progress line', async () => {
    restoreStderrIsTTY = setStreamIsTTY(process.stderr, false);
    mocks.runFullAnalysisMock.mockImplementation(
      async (
        _repoPath: string,
        _options: unknown,
        callbacks: { onProgress: (phase: string, percent: number, message: string) => void },
      ) => {
        callbacks.onProgress('scan', 10, 'Scanning repository... (src/\x1b[2Jevil\r\n.ts)');
        return { repoName: 'repo', repoPath: '/repo', stats: {}, alreadyUpToDate: true };
      },
    );
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(mocks.barUpdate).toHaveBeenCalledWith(10, {
      phase: 'Scanning repository... (src/[2Jevil .ts)',
    });
  });

  it('writes no cursor controls around log lines when stderr is not a terminal', async () => {
    restoreStderrIsTTY = setStreamIsTTY(process.stderr, false);
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(mocks.runFullAnalysisMock).toHaveBeenCalledTimes(1);
    expect(stdoutWriteSpy).not.toHaveBeenCalledWith('\x1b[2K\r');
  });

  it('keeps the redrawn bar and its line clearing on a terminal', async () => {
    restoreStderrIsTTY = setStreamIsTTY(process.stderr, true);
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    const options = mocks.capturedBarOptions[0];
    expect(options.noTTYOutput).toBeUndefined();
    expect(options.notTTYSchedule).toBeUndefined();
    expect(options.format).toBe('  {bar} {percentage}% | {phase}');
    expect(options.clearOnComplete).toBe(false);
    expect(options.terminal).toBeUndefined();
    expect(mocks.runFullAnalysisMock).toHaveBeenCalledTimes(1);
    expect(stdoutWriteSpy).toHaveBeenCalledWith('\x1b[2K\r');
  });
});
