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

// Pin physical RAM to 16GB so the RAM-aware auto-cap (0.75 x RAM, clamped
// >= 16384) resolves deterministically to 16384 regardless of the host machine.
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
    expect(args).toContain('--max-old-space-size=16384');
    expect(args).toContain('--max-semi-space-size=128');
    expect(opts.env.NODE_OPTIONS).toContain('--max-old-space-size=16384');
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
    expect(msg).toContain('auto-sized to 16384MB');
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

describe('computeHeapCapMb (RAM-aware auto heap cap)', () => {
  const GB = 1024 * 1024 * 1024;

  it('sizes to 0.75x physical RAM when unconstrained', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // 31GB -> 31744MB -> floor(0.75 * 31744) = 23808
    expect(computeHeapCapMb(31 * GB, null)).toBe(23808);
  });

  it('clamps to the 16384 floor on small boxes', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // 8GB -> 0.75 * 8192 = 6144 -> clamped to 16384
    expect(computeHeapCapMb(8 * GB, null)).toBe(16384);
  });

  it('ignores the unconstrained sentinel from constrainedMemory()', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // ~1.8e19 sentinel > totalmem -> ignored, uses physical RAM
    expect(computeHeapCapMb(31 * GB, 1.8e19)).toBe(23808);
  });

  it('honors a real cgroup cap smaller than physical RAM', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // min(31, 12) = 12GB -> 0.75 * 12288 = 9216 -> clamped to 16384
    expect(computeHeapCapMb(31 * GB, 12 * GB)).toBe(16384);
  });

  it('uses a large cgroup cap when it exceeds the floor', async () => {
    const { computeHeapCapMb } = await import('../../src/cli/analyze.js');
    // 48GB cap on a 64GB box -> floor(0.75 * 49152) = 36864
    expect(computeHeapCapMb(64 * GB, 48 * GB)).toBe(36864);
  });
});
