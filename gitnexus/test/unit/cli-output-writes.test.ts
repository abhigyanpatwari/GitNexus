/**
 * output() in src/cli/tool.ts must deliver every byte of a tool result to fd 1.
 * A pipe or socket on POSIX makes fd 1 non-blocking, so one writeSync can land
 * only part of a large payload or throw EAGAIN (#3947). The fake fd below plays
 * those kernel answers back and records the raw bytes that "reached" stdout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const callToolMock = vi.fn();
const writeSyncMock = vi.fn();

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = vi.fn().mockResolvedValue(true);
    callTool = callToolMock;
    disconnect = vi.fn();
  },
}));

vi.mock('node:fs', () => ({ writeSync: writeSyncMock }));

/** Bytes the fake fd accepted, in order. */
let received: Buffer[] = [];

/** A fake fd that accepts at most `max` bytes per call, like a nearly full pipe. */
const accept =
  (max: number) =>
  (_fd: number, bytes: Buffer, offset = 0): number => {
    const chunk = bytes.subarray(offset, offset + max);
    received.push(chunk);
    return chunk.length;
  };

const errno = (code: string): Error => Object.assign(new Error(code), { code });

const fail = (code: string) => (): never => {
  throw errno(code);
};

// Over 64 KiB, and the 2-byte "é" runs start at an odd offset, so the
// 1,000-byte cuts below fall inside a character.
const bigResult = { markdown: 'é'.repeat(40_000), row_count: 40_000 };

const stdoutText = (): string => Buffer.concat(received).toString('utf8');

describe('output() writes the whole payload (#3947)', () => {
  beforeEach(() => {
    vi.resetModules();
    callToolMock.mockReset();
    writeSyncMock.mockReset();
    received = [];
    process.exitCode = undefined;
  });

  // Some scenarios expect exit code 1 on the real process; clear it so they do
  // not fail the whole run.
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('keeps writing after short writes, splitting multi-byte characters safely', async () => {
    writeSyncMock.mockImplementation(accept(1000));
    callToolMock.mockResolvedValue(bigResult);
    const { cypherCommand } = await import('../../src/cli/tool.js');

    await cypherCommand('MATCH (n) RETURN n');

    expect(writeSyncMock.mock.calls.length).toBeGreaterThan(65);
    expect(stdoutText().endsWith('\n')).toBe(true);
    expect(JSON.parse(stdoutText())).toEqual(bigResult);
  });

  it('waits and retries when the pipe is full (EAGAIN)', async () => {
    const wait = vi.spyOn(Atomics, 'wait');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeSyncMock
      .mockImplementationOnce(accept(1000))
      .mockImplementationOnce(fail('EAGAIN'))
      .mockImplementation(accept(Infinity));
    callToolMock.mockResolvedValue(bigResult);
    const { cypherCommand } = await import('../../src/cli/tool.js');

    await cypherCommand('MATCH (n) RETURN n');

    expect(JSON.parse(stdoutText())).toEqual(bigResult);
    expect(wait).toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('stops quietly on EPIPE and keeps a clean exit code', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeSyncMock.mockImplementationOnce(accept(1000)).mockImplementation(fail('EPIPE'));
    callToolMock.mockResolvedValue(bigResult);
    const { cypherCommand } = await import('../../src/cli/tool.js');

    await cypherCommand('MATCH (n) RETURN n');

    expect(exit).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps the failure exit code of a partial result on EPIPE', async () => {
    writeSyncMock.mockImplementationOnce(accept(1000)).mockImplementation(fail('EPIPE'));
    callToolMock.mockResolvedValue({ ...bigResult, partial: true });
    const { cypherCommand } = await import('../../src/cli/tool.js');

    await cypherCommand('MATCH (n) RETURN n');

    expect(process.exitCode).toBe(1);
  });

  it('keeps the cycles-found exit code of check on EPIPE', async () => {
    writeSyncMock.mockImplementation(fail('EPIPE'));
    callToolMock.mockResolvedValue({
      status: 'cycles_found',
      cycleCount: 1,
      cycles: [{ files: ['src/a.ts', 'src/b.ts', 'src/a.ts'] }],
    });
    const { checkCommand } = await import('../../src/cli/tool.js');

    await checkCommand({ cycles: true });

    expect(process.exitCode).toBe(1);
  });

  it('falls back to stderr and fails when stdout breaks after a partial write', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeSyncMock.mockImplementationOnce(accept(1000)).mockImplementation(fail('EIO'));
    callToolMock.mockResolvedValue(bigResult);
    const { cypherCommand } = await import('../../src/cli/tool.js');

    await cypherCommand('MATCH (n) RETURN n');

    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toEqual(bigResult);
    expect(process.exitCode).toBe(1);
  });

  it('falls back to stderr with a clean exit code when nothing reached stdout', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeSyncMock.mockImplementation(fail('EIO'));
    callToolMock.mockResolvedValue(bigResult);
    const { cypherCommand } = await import('../../src/cli/tool.js');

    await cypherCommand('MATCH (n) RETURN n');

    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toEqual(bigResult);
    expect(process.exitCode).toBeUndefined();
  });
});
