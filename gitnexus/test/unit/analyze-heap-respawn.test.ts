import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
const getHeapStatisticsMock = vi.fn();

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: spawnMock };
});

vi.mock('v8', () => ({
  default: {
    getHeapStatistics: getHeapStatisticsMock,
  },
}));

// Pin physical RAM to 16GB so the RAM-aware auto-cap (floor raised to 16384
// but capped at 0.80 x RAM, #2649) resolves deterministically to 13107
// regardless of the host machine.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = { ...actual, totalmem: () => 16 * 1024 * 1024 * 1024 };
  return { ...mocked, default: mocked };
});

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
  closeLbugBeforeExit: vi.fn(async () => undefined),
  isLbugReady: vi.fn(() => false),
}));

const mockSpawnExit = ({
  status = 0,
  signal = null,
  stdout = '',
  stderr = '',
}: {
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
} = {}) => {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', status, signal);
    });
    return child;
  });
};

const setStreamIsTTY = (stream: NodeJS.WriteStream, value: boolean): (() => void) => {
  const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  Object.defineProperty(stream, 'isTTY', { configurable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else delete (stream as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
  };
};

describe('analyzeCommand heap respawn', () => {
  let initialNodeOptions: string | undefined;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let restoreStdoutIsTTY: (() => void) | undefined;
  let restoreStderrIsTTY: (() => void) | undefined;
  let restoreConstrainedMemory: (() => void) | undefined;

  beforeEach(() => {
    initialNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.GITNEXUS_MEMORY;
    vi.resetModules();
    spawnMock.mockReset();
    getHeapStatisticsMock.mockReset();
    process.exitCode = undefined;
    // Force the unconstrained path so the auto-cap uses the mocked totalmem (16GB).
    const cmDesc = Object.getOwnPropertyDescriptor(process, 'constrainedMemory');
    Object.defineProperty(process, 'constrainedMemory', { configurable: true, value: () => 0 });
    restoreConstrainedMemory = () => {
      if (cmDesc) Object.defineProperty(process, 'constrainedMemory', cmDesc);
      else delete (process as { constrainedMemory?: unknown }).constrainedMemory;
    };
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    restoreStdoutIsTTY?.();
    restoreStderrIsTTY?.();
    restoreConstrainedMemory?.();
    restoreStdoutIsTTY = undefined;
    restoreStderrIsTTY = undefined;
    restoreConstrainedMemory = undefined;
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    if (initialNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = initialNodeOptions;
  });

  it('re-execs analyze with the auto-sized heap cap (16GB-clamped) + larger semi-space and bridges progress redraw when parent is a TTY', async () => {
    delete process.env.NODE_OPTIONS;
    restoreStderrIsTTY = setStreamIsTTY(process.stderr, true);
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    mockSpawnExit();

    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(args).toContain('--max-old-space-size=13107');
    expect(args).toContain('--max-semi-space-size=128');
    expect(opts.env.NODE_OPTIONS).toContain('--max-old-space-size=13107');
    expect(opts.env.NODE_OPTIONS).toContain('--max-semi-space-size=128');
    expect(opts.env.GITNEXUS_RESPAWN_PROGRESS_TTY).toBe('1');
  });

  it('does not force ANSI progress when the parent output is not a TTY', async () => {
    delete process.env.NODE_OPTIONS;
    restoreStdoutIsTTY = setStreamIsTTY(process.stdout, false);
    restoreStderrIsTTY = setStreamIsTTY(process.stderr, false);
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    mockSpawnExit();

    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.env.GITNEXUS_RESPAWN_PROGRESS_TTY).toBeUndefined();
  });

  it('does not re-exec when NODE_OPTIONS already defines max-old-space-size', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=32768';
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });

    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand('/__gitnexus_nonexistent__', {});

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('re-execs with the auto cap when ambient NODE_OPTIONS pins a smaller heap (#2649)', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 4096 * 1024 * 1024 });
    mockSpawnExit();

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});
    cap.restore();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(args).toContain('--max-old-space-size=13107');
    // The auto flag is appended after the ambient value, so V8's
    // later-flag-wins semantics resolve to the larger cap.
    expect(opts.env.NODE_OPTIONS.indexOf('--max-old-space-size=13107')).toBeGreaterThan(
      opts.env.NODE_OPTIONS.indexOf('--max-old-space-size=4096'),
    );
    const warn = cap.records().find((r) => r.msg.includes('pins the heap to 4096MB'));
    expect(warn?.msg).toContain('Re-running analyze with the larger auto-sized cap');
  });

  it('honors GITNEXUS_MEMORY=off: keeps the small ambient heap, silently (#2649)', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    process.env.GITNEXUS_MEMORY = 'off';
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 4096 * 1024 * 1024 });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand('/__gitnexus_nonexistent__', {});
    cap.restore();

    expect(spawnMock).not.toHaveBeenCalled();
    // Explicit opt-out stays quiet: stderr-sensitive consumers (e2e
    // harnesses, scripts) rely on no extra warning here.
    const warns = cap.records().filter((r) => r.msg.includes('pins the heap'));
    expect(warns).toEqual([]);
  });

  it('preserves parent execArgv (e.g. a tsx loader) in the respawned child argv (#2649)', async () => {
    delete process.env.NODE_OPTIONS;
    restoreStderrIsTTY = setStreamIsTTY(process.stderr, true);
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    mockSpawnExit();

    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    // The child argv must start with the parent's node flags so
    // loader-launched CLIs (node --import tsx src/cli/index.ts) survive the
    // respawn; our heap flags follow and win via later-flag-wins.
    expect(args.slice(0, process.execArgv.length)).toEqual(process.execArgv);
  });

  it('parseMaxOldSpaceMb: last occurrence wins, absent and malformed values are null', async () => {
    const { parseMaxOldSpaceMb } = await import('../../src/cli/analyze.js');
    expect(parseMaxOldSpaceMb('--max-old-space-size=4096 --max-old-space-size=8192')).toBe(8192);
    expect(parseMaxOldSpaceMb('--max-semi-space-size=128')).toBeNull();
    expect(parseMaxOldSpaceMb('')).toBeNull();
    expect(parseMaxOldSpaceMb('--max-old-space-size=0')).toBeNull();
    // V8 treats - and _ interchangeably in flag names, and Node accepts a
    // space-separated value in NODE_OPTIONS; every spelling of the pin must
    // be honored instead of silently overridden.
    expect(parseMaxOldSpaceMb('--max_old_space_size=4096')).toBe(4096);
    expect(parseMaxOldSpaceMb('--max-old-space-size 4096')).toBe(4096);
    expect(parseMaxOldSpaceMb('--max-old-space-size --other-flag')).toBeNull();
  });

  it('preserves conventional signal exits for analyze but treats watch shutdown as clean', async () => {
    const { forwardedSignalExitCode } = await import('../../src/cli/analyze.js');
    expect(forwardedSignalExitCode('SIGINT', false)).toBe(130);
    expect(forwardedSignalExitCode('SIGTERM', false)).toBe(143);
    expect(forwardedSignalExitCode('SIGINT', true)).toBe(0);
    expect(forwardedSignalExitCode('SIGTERM', true)).toBe(0);
    expect(forwardedSignalExitCode('SIGABRT', false)).toBe(1);
  });

  it('GITNEXUS_MEMORY=off also disables the default (unpinned) respawn (#2649 review)', async () => {
    delete process.env.NODE_OPTIONS;
    process.env.GITNEXUS_MEMORY = 'off';
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });

    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand('/__gitnexus_nonexistent__', {});

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('an explicit per-invocation execArgv heap flag always wins (no respawn)', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    const execArgvDesc = Object.getOwnPropertyDescriptor(process, 'execArgv');
    Object.defineProperty(process, 'execArgv', {
      configurable: true,
      value: ['--max-old-space-size=2048'],
    });
    try {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');
      await analyzeCommand('/__gitnexus_nonexistent__', {});
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      if (execArgvDesc) Object.defineProperty(process, 'execArgv', execArgvDesc);
    }
  });

  it('does not replay --inspect flags into the respawned child (debug-port clash)', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    mockSpawnExit();
    const execArgvDesc = Object.getOwnPropertyDescriptor(process, 'execArgv');
    Object.defineProperty(process, 'execArgv', {
      configurable: true,
      value: ['--inspect', '--inspect-brk=9230', '--enable-source-maps'],
    });
    try {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');
      await analyzeCommand(undefined, {});
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, args] = spawnMock.mock.calls[0];
      expect({
        inspectFlags: args.filter((a: string) => a.startsWith('--inspect')),
        keepsOtherFlags: args.includes('--enable-source-maps'),
      }).toEqual({ inspectFlags: [], keepsOtherFlags: true });
    } finally {
      if (execArgvDesc) Object.defineProperty(process, 'execArgv', execArgvDesc);
    }
  });

  it('prints heap guidance when respawned analyze exits with likely OOM', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    mockSpawnExit({ status: null, signal: 'SIGABRT' });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    // Signal-only child failures do not carry a numeric status, so the CLI
    // falls back to exit code 1.
    expect(process.exitCode).toBe(1);
    const oomGuidance = cap
      .records()
      .find((r) => r.msg.includes('Analysis likely ran out of memory'));
    expect(oomGuidance).toBeDefined();
    const msg = oomGuidance?.msg ?? '';
    expect(msg).toContain('auto-sized to 13107MB');
    expect(msg).toContain('NODE_OPTIONS="--max-old-space-size=<MB>"');
    expect(msg).toContain('[your-args]');
    expect(msg).toContain('native crash unrelated to heap size');
    cap.restore();
  });

  it('prints heap guidance when child stderr contains heap OOM signature', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    mockSpawnExit({
      status: 1,
      signal: null,
      stderr: Buffer.from(
        'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      ),
    });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);
    expect(cap.records().some((r) => r.msg.includes('Analysis likely ran out of memory'))).toBe(
      true,
    );
    cap.restore();
  });

  it('prints heap guidance when child stdout contains heap OOM signature', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    mockSpawnExit({
      status: 1,
      signal: null,
      stdout: 'FATAL ERROR: JavaScript heap out of memory',
    });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);
    expect(cap.records().some((r) => r.msg.includes('Analysis likely ran out of memory'))).toBe(
      true,
    );
    cap.restore();
  });

  it('prints heap guidance when child exits 134 without output', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    mockSpawnExit({ status: 134, signal: null, stderr: '', stdout: '' });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(134);
    expect(cap.records().some((r) => r.msg.includes('Analysis likely ran out of memory'))).toBe(
      true,
    );
    cap.restore();
  });

  it('does not print heap guidance for non-OOM child failures with output', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    mockSpawnExit({
      status: 2,
      signal: null,
      stderr: Buffer.from('parser failed: invalid token'),
    });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(2);
    expect(cap.records().some((r) => r.msg.includes('Analysis likely ran out of memory'))).toBe(
      false,
    );
    cap.restore();
  });

  it('does not print heap guidance when a SIGABRT child emitted a native N-API crash', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    mockSpawnExit({
      status: 134,
      signal: null,
      stderr: Buffer.from('libc++abi: terminating due to uncaught exception of type Napi::Error'),
    });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(134);
    expect(cap.records().some((r) => r.msg.includes('Analysis likely ran out of memory'))).toBe(
      false,
    );
    expect(cap.records().some((r) => r.msg.includes('Analysis aborted in a native worker'))).toBe(
      true,
    );
    expect(cap.records().some((r) => r.recoveryHint === 'native-worker-abort')).toBe(true);
    expect(stderrWriteSpy).toHaveBeenCalled();
    cap.restore();
  });
});

const MB = 1024 * 1024;

/** Run `body` with `process.execArgv` replaced, restoring it afterwards. */
const withExecArgv = async (execArgv: string[], body: () => Promise<void>): Promise<void> => {
  const execArgvDesc = Object.getOwnPropertyDescriptor(process, 'execArgv');
  Object.defineProperty(process, 'execArgv', { configurable: true, value: execArgv });
  try {
    await body();
  } finally {
    if (execArgvDesc) Object.defineProperty(process, 'execArgv', execArgvDesc);
  }
};

/** Pin the cgroup limit so the auto cap resolves to `floor(0.8 × mb)`. */
const constrainTo = (mb: number): void => {
  Object.defineProperty(process, 'constrainedMemory', {
    configurable: true,
    value: () => mb * MB,
  });
};

describe('ensureHeap --memory-budget (#3137)', () => {
  let initialNodeOptions: string | undefined;
  let initialSource: string | undefined;
  let initialMemory: string | undefined;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let restoreConstrainedMemory: (() => void) | undefined;

  beforeEach(() => {
    initialNodeOptions = process.env.NODE_OPTIONS;
    initialSource = process.env.GITNEXUS_HEAP_LIMIT_SOURCE;
    initialMemory = process.env.GITNEXUS_MEMORY;
    delete process.env.NODE_OPTIONS;
    delete process.env.GITNEXUS_MEMORY;
    delete process.env.GITNEXUS_HEAP_LIMIT_SOURCE;
    vi.resetModules();
    spawnMock.mockReset();
    getHeapStatisticsMock.mockReset();
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * MB });
    process.exitCode = undefined;
    const cmDesc = Object.getOwnPropertyDescriptor(process, 'constrainedMemory');
    // Unconstrained: the mocked 16GB totalmem gives an auto cap of 13107MB.
    Object.defineProperty(process, 'constrainedMemory', { configurable: true, value: () => 0 });
    restoreConstrainedMemory = () => {
      if (cmDesc) Object.defineProperty(process, 'constrainedMemory', cmDesc);
      else delete (process as { constrainedMemory?: unknown }).constrainedMemory;
    };
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    restoreConstrainedMemory?.();
    restoreConstrainedMemory = undefined;
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    if (initialNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = initialNodeOptions;
    if (initialSource === undefined) delete process.env.GITNEXUS_HEAP_LIMIT_SOURCE;
    else process.env.GITNEXUS_HEAP_LIMIT_SOURCE = initialSource;
    if (initialMemory === undefined) delete process.env.GITNEXUS_MEMORY;
    else process.env.GITNEXUS_MEMORY = initialMemory;
    process.exitCode = undefined;
  });

  it('replaces an 8192MB execArgv pin with a 2000MB heap, logging one line that names the pin', async () => {
    mockSpawnExit();
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    await withExecArgv(['--max-old-space-size=8192'], async () => {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');
      await analyzeCommand(undefined, { memoryBudget: '2000' });
    });
    cap.restore();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0];
    const records = cap.records();
    expect({
      // The budget flags follow the user's pin, so V8's later-flag-wins
      // semantics resolve to old 1616 + 3 × semi 128 = 2000MB.
      budgetFlagsAfterPin:
        args.indexOf('--max-old-space-size=1616') > args.indexOf('--max-old-space-size=8192'),
      semi: args.includes('--max-semi-space-size=128'),
      nodeOptions: opts.env.NODE_OPTIONS,
      source: opts.env.GITNEXUS_HEAP_LIMIT_SOURCE,
      recordCount: records.length,
      namesPin: records[0]?.msg.includes('8192MB'),
      namesBudget: records[0]?.msg.includes('2000MB'),
    }).toEqual({
      budgetFlagsAfterPin: true,
      semi: true,
      nodeOptions: '--max-old-space-size=1616 --max-semi-space-size=128',
      source: 'budget',
      recordCount: 1,
      namesPin: true,
      namesBudget: true,
    });
  });

  it('raises a 1024MB NODE_OPTIONS pin to a 3000MB heap, without the below-cap warning', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=1024';
    mockSpawnExit();
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { memoryBudget: '3000' });
    cap.restore();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    const records = cap.records();
    expect({
      // 3000 / 25 = 120 rounds up to V8's power-of-two semi-space 128.
      old: args.includes('--max-old-space-size=2616'),
      semi: args.includes('--max-semi-space-size=128'),
      recordCount: records.length,
      namesPin: records[0]?.msg.includes('1024MB'),
      namesAutoCap: records[0]?.msg.includes('13107MB'),
    }).toEqual({ old: true, semi: true, recordCount: 1, namesPin: true, namesAutoCap: false });
  });

  it('a 12000MB budget above a 6000MB auto cap respawns at 12000 with a swap-risk warning', async () => {
    // 7500MB cgroup limit -> auto cap floor(0.8 × 7500) = 6000MB.
    constrainTo(7500);
    mockSpawnExit();
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { memoryBudget: '12000' });
    cap.restore();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    const records = cap.records();
    expect({
      old: args.includes('--max-old-space-size=11616'),
      recordCount: records.length,
      namesAutoCap: records[0]?.msg.includes('6000MB'),
      warnsSwap: /swap/i.test(records[0]?.msg ?? ''),
    }).toEqual({ old: true, recordCount: 1, namesAutoCap: true, warnsSwap: true });
  });

  it('a budget-respawned child (8192 pin, then the budget flags) proceeds silently', async () => {
    process.env.GITNEXUS_HEAP_LIMIT_SOURCE = 'budget';
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    let respawned: boolean | undefined;
    await withExecArgv(
      ['--max-old-space-size=8192', '--max-old-space-size=1616', '--max-semi-space-size=128'],
      async () => {
        const { ensureHeap } = await import('../../src/cli/analyze.js');
        respawned = await ensureHeap({ memoryBudget: '2000' });
      },
    );
    cap.restore();

    expect({ respawned, spawns: spawnMock.mock.calls.length, records: cap.records() }).toEqual({
      respawned: false,
      spawns: 0,
      records: [],
    });
  });

  it('a pin equal to the budget is not the exact budget heap, so the process respawns once', async () => {
    mockSpawnExit();
    constrainTo(7500);
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    let respawned: boolean | undefined;
    await withExecArgv(['--max-old-space-size=12000'], async () => {
      const { ensureHeap } = await import('../../src/cli/analyze.js');
      respawned = await ensureHeap({ memoryBudget: '12000' });
    });
    cap.restore();

    const [, args, opts] = spawnMock.mock.calls[0];
    const records = cap.records();
    expect({
      respawned,
      flags: args.filter(
        (a: string) => a.startsWith('--max-old-space') || a.startsWith('--max-semi'),
      ),
      source: opts.env.GITNEXUS_HEAP_LIMIT_SOURCE,
      recordCount: records.length,
      warnsSwap: /swap/i.test(records[0]?.msg ?? ''),
    }).toEqual({
      respawned: true,
      flags: [
        '--max-old-space-size=12000',
        '--max-old-space-size=11616',
        '--max-semi-space-size=128',
      ],
      source: 'budget',
      recordCount: 1,
      warnsSwap: true,
    });
  });

  it('a programmatic caller passing an invalid budget exits 1 without respawning', async () => {
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { memoryBudget: '199' });
    cap.restore();

    expect({
      exitCode: process.exitCode,
      spawns: spawnMock.mock.calls.length,
      namesMinimum: cap.records().some((r) => /--memory-budget.*200/.test(String(r.msg ?? ''))),
    }).toEqual({ exitCode: 1, spawns: 0, namesMinimum: true });
  });

  it('a kept process does not leak its heap source into a later analyzeCommand call', async () => {
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 13107 * MB });
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    // An invalid --workers returns right after ensureHeap kept the process and
    // recorded its source, so the env restore runs without a full analyze.
    await analyzeCommand(undefined, { workers: '0' });
    expect(process.env.GITNEXUS_HEAP_LIMIT_SOURCE).toBeUndefined();
  });

  it('budget 200 scales the semi-space down so old + 3 × semi equals 200', async () => {
    mockSpawnExit();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { memoryBudget: '200' });

    const [, args] = spawnMock.mock.calls[0];
    expect(
      args.filter((a: string) => a.startsWith('--max-old-space') || a.startsWith('--max-semi')),
    ).toEqual(['--max-old-space-size=176', '--max-semi-space-size=8']);
  });

  it('a forged budget marker without the budget semi-space flag still respawns', async () => {
    mockSpawnExit();
    process.env.GITNEXUS_HEAP_LIMIT_SOURCE = 'budget';
    let respawned: boolean | undefined;
    await withExecArgv(['--max-old-space-size=1616'], async () => {
      const { ensureHeap } = await import('../../src/cli/analyze.js');
      respawned = await ensureHeap({ memoryBudget: '2000' });
    });
    expect({ respawned, spawns: spawnMock.mock.calls.length }).toEqual({
      respawned: true,
      spawns: 1,
    });
  });

  it('a budget child whose old-space pin is spelled with underscores and a space skips the respawn', async () => {
    process.env.GITNEXUS_HEAP_LIMIT_SOURCE = 'budget';
    let respawned: boolean | undefined;
    await withExecArgv(['--max_old_space_size', '1616', '--max-semi-space-size=128'], async () => {
      const { ensureHeap } = await import('../../src/cli/analyze.js');
      respawned = await ensureHeap({ memoryBudget: '2000' });
    });

    expect({
      respawned,
      spawns: spawnMock.mock.calls.length,
      source: process.env.GITNEXUS_HEAP_LIMIT_SOURCE,
    }).toEqual({ respawned: false, spawns: 0, source: 'budget' });
  });

  it('GITNEXUS_MEMORY=off still respawns at an explicit budget', async () => {
    process.env.GITNEXUS_MEMORY = 'off';
    mockSpawnExit();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { memoryBudget: '2000' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0];
    expect({
      old: args.includes('--max-old-space-size=1616'),
      source: opts.env.GITNEXUS_HEAP_LIMIT_SOURCE,
    }).toEqual({ old: true, source: 'budget' });
  });

  it('without a budget the auto respawn keeps its exact argv and records source=auto in the child env', async () => {
    mockSpawnExit();
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});
    cap.restore();

    const [, args, opts] = spawnMock.mock.calls[0];
    const preserved = process.execArgv.filter((a) => !a.startsWith('--inspect'));
    expect({ args, source: opts.env.GITNEXUS_HEAP_LIMIT_SOURCE, records: cap.records() }).toEqual({
      args: [
        ...preserved,
        '--max-old-space-size=13107',
        '--max-semi-space-size=128',
        '--stack-size=4096',
        ...process.argv.slice(1),
      ],
      source: 'auto',
      records: [],
    });
  });

  it('a process already at the auto cap records source=auto for itself', async () => {
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 13107 * MB });
    const { ensureHeap } = await import('../../src/cli/analyze.js');
    const respawned = await ensureHeap();

    expect({ respawned, source: process.env.GITNEXUS_HEAP_LIMIT_SOURCE }).toEqual({
      respawned: false,
      source: 'auto',
    });
  });

  it('the respawn OOM message names the budget and --memory-budget instead of NODE_OPTIONS', async () => {
    mockSpawnExit({ status: null, signal: 'SIGABRT' });
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { memoryBudget: '2000' });
    cap.restore();

    const oom = cap.records().find((r) => r.recoveryHint === 'heap-oom-respawn');
    expect({
      exitCode: process.exitCode,
      namesBudget: oom?.msg.includes('2000MB'),
      namesFlag: oom?.msg.includes('--memory-budget'),
      mentionsNodeOptions: oom?.msg.includes('NODE_OPTIONS'),
    }).toEqual({ exitCode: 1, namesBudget: true, namesFlag: true, mentionsNodeOptions: false });
  });

  it('analyze --watch --memory-budget 2000 goes through the same budget respawn', async () => {
    mockSpawnExit();
    const { analyzeOrWatchCommandWithRunnerIdentity } = await import('../../src/cli/analyze.js');
    const { resolveAnalyzerRunnerIdentity } = await import('../../src/core/analyzer-identity.js');
    const identity = resolveAnalyzerRunnerIdentity(
      new URL('../../src/cli/analyze.ts', import.meta.url).href,
    );
    await analyzeOrWatchCommandWithRunnerIdentity(identity, undefined, {
      watch: true,
      memoryBudget: '2000',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0];
    expect({
      old: args.includes('--max-old-space-size=1616'),
      source: opts.env.GITNEXUS_HEAP_LIMIT_SOURCE,
      exitCode: process.exitCode,
    }).toEqual({ old: true, source: 'budget', exitCode: undefined });
  });
});

describe('computeHeapCapMb (RAM-aware auto heap cap)', () => {
  const GB = 1024 * 1024 * 1024;

  it('sizes to 0.75x physical RAM when unconstrained', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // 31GB -> 31744MB -> floor(0.75 * 31744) = 23808
    expect(computeHeapCapMb(31 * GB, null)).toBe(23808);
  });

  it('keeps the cap below RAM on small boxes instead of the old >=RAM floor (#2649)', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // 8GB -> floor wins the max (16384) but is capped to 0.80 * 8192 = 6553
    expect(computeHeapCapMb(8 * GB, null)).toBe(6553);
  });

  it('caps a 16GB box at 0.80x RAM, below physical memory (#2649)', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // 16GB -> max(16384, 12288) = 16384 -> min(16384, floor(0.80 * 16384)) = 13107
    expect(computeHeapCapMb(16 * GB, null)).toBe(13107);
  });

  it('lets the 0.75x rule win once RAM clears the floor region', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // 24GB -> max(16384, 18432) = 18432 -> min(18432, 19660) = 18432
    expect(computeHeapCapMb(24 * GB, null)).toBe(18432);
  });

  it('ignores the unconstrained sentinel from constrainedMemory()', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // ~1.8e19 sentinel > totalmem -> ignored, uses physical RAM
    expect(computeHeapCapMb(31 * GB, 1.8e19)).toBe(23808);
  });

  it('honors a real cgroup cap smaller than physical RAM', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // min(31, 12) = 12GB effective -> capped to 0.80 * 12288 = 9830, not the 16384 floor
    expect(computeHeapCapMb(31 * GB, 12 * GB)).toBe(9830);
  });

  it('never returns a cap at or above effective RAM', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    const ramsGb = [4, 8, 12, 16, 20, 24, 32, 48, 64];
    const caps = ramsGb.map((gb) => computeHeapCapMb(gb * GB, null));
    const belowRam = caps.map((cap, i) => cap < ramsGb[i] * 1024);
    expect(belowRam).toEqual(ramsGb.map(() => true));
  });

  it('uses a large cgroup cap when it exceeds the floor', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // 48GB cap on a 64GB box -> floor(0.75 * 49152) = 36864
    expect(computeHeapCapMb(64 * GB, 48 * GB)).toBe(36864);
  });
});
