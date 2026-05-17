import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();
const getHeapStatisticsMock = vi.fn();

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFileSync: execFileSyncMock };
});

vi.mock('v8', () => ({
  default: {
    getHeapStatistics: getHeapStatisticsMock,
  },
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
}));

describe('analyzeCommand heap respawn', () => {
  let initialNodeOptions: string | undefined;

  beforeEach(() => {
    initialNodeOptions = process.env.NODE_OPTIONS;
    vi.resetModules();
    execFileSyncMock.mockReset();
    getHeapStatisticsMock.mockReset();
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (initialNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = initialNodeOptions;
  });

  it('re-execs analyze with 16GB heap when no max-old-space-size is present', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });

    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = execFileSyncMock.mock.calls[0];
    expect(args).toContain('--max-old-space-size=16384');
    expect(opts.env.NODE_OPTIONS).toContain('--max-old-space-size=16384');
  });

  it('does not re-exec when NODE_OPTIONS already defines max-old-space-size', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=32768';
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });

    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand('/__gitnexus_nonexistent__', {});

    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('prints heap guidance when respawned analyze exits with likely OOM', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    execFileSyncMock.mockImplementationOnce(() => {
      const err = new Error('child failed') as Error & { status?: number; signal?: string };
      err.status = undefined;
      err.signal = 'SIGABRT';
      throw err;
    });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    // Signal-only child failures do not carry a numeric status, so the CLI
    // falls back to exit code 1.
    expect(process.exitCode).toBe(1);
    const oomGuidance = cap
      .records()
      .find((r) => r.msg.includes('Analysis likely ran out of memory.'));
    expect(oomGuidance).toBeDefined();
    const msg = oomGuidance?.msg ?? '';
    expect(msg).toContain('NODE_OPTIONS="--max-old-space-size=24576"');
    expect(msg).toContain('[your-args]');
    expect(msg).toContain('native crash unrelated to heap size');
    cap.restore();
  });

  it('prints heap guidance when child stderr contains heap OOM signature', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    execFileSyncMock.mockImplementationOnce(() => {
      const err = new Error('Command failed') as Error & {
        status?: number;
        signal?: string;
        stderr?: Buffer;
      };
      err.status = 1;
      err.signal = undefined;
      err.stderr = Buffer.from(
        'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      );
      throw err;
    });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);
    expect(cap.records().some((r) => r.msg.includes('Analysis likely ran out of memory.'))).toBe(
      true,
    );
    cap.restore();
  });

  it('prints heap guidance when child stdout contains heap OOM signature', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    execFileSyncMock.mockImplementationOnce(() => {
      const err = new Error('Command failed') as Error & {
        status?: number;
        signal?: string;
        stdout?: string;
      };
      err.status = 1;
      err.signal = undefined;
      err.stdout = 'FATAL ERROR: JavaScript heap out of memory';
      throw err;
    });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);
    expect(cap.records().some((r) => r.msg.includes('Analysis likely ran out of memory.'))).toBe(
      true,
    );
    cap.restore();
  });

  it('prints heap guidance when child exits 134 without output', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    execFileSyncMock.mockImplementationOnce(() => {
      const err = new Error('Command failed') as Error & {
        status?: number;
        signal?: string;
        stderr?: string;
        stdout?: string;
      };
      err.status = 134;
      err.signal = undefined;
      err.stderr = '';
      err.stdout = '';
      throw err;
    });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(134);
    expect(cap.records().some((r) => r.msg.includes('Analysis likely ran out of memory.'))).toBe(
      true,
    );
    cap.restore();
  });

  it('does not print heap guidance for non-OOM child failures with output', async () => {
    delete process.env.NODE_OPTIONS;
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    execFileSyncMock.mockImplementationOnce(() => {
      const err = new Error('Command failed') as Error & {
        status?: number;
        signal?: string;
        stderr?: Buffer;
      };
      err.status = 2;
      err.signal = undefined;
      err.stderr = Buffer.from('parser failed: invalid token');
      throw err;
    });

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(2);
    expect(cap.records().some((r) => r.msg.includes('Analysis likely ran out of memory.'))).toBe(
      false,
    );
    cap.restore();
  });
});
