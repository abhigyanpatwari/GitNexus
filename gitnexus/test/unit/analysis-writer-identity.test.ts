import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as indexLock from '../../src/storage/index-lock.js';
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => mocks.execute(...args) }));
import {
  isAnalysisWriterBirth,
  readAnalysisWriterBirth,
} from '../../src/core/analysis-writer-identity.js';

afterEach(() => {
  vi.restoreAllMocks();
  mocks.execute.mockReset();
});
describe('analysis writer birth identity', () => {
  it('reads Linux process start ticks', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(indexLock, 'readProcStartTime').mockReturnValue('12345');
    expect(await readAnalysisWriterBirth(123)).toEqual({ kind: 'linux-proc', value: '12345' });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each([
    ['darwin', 'Sat Nov  7 13:02:03 2026\n', 'darwin-lstart', 'Sat Nov 7 13:02:03 2026'],
    ['win32', '639296533230000000\r\n', 'win32-ticks', '639296533230000000'],
  ] as const)('uses a bounded, locale-stable %s probe', async (platform, stdout, kind, value) => {
    vi.spyOn(os, 'platform').mockReturnValue(platform);
    mocks.execute.mockImplementation((_file, _args, _options, callback) =>
      callback(null, stdout, ''),
    );
    expect(await readAnalysisWriterBirth(123, 42)).toEqual({ kind, value });
    const [file, args, options] = mocks.execute.mock.calls[0];
    expect(file).toMatch(
      platform === 'darwin' ? /^\/bin\/ps$/ : /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/,
    );
    expect(args.join(' ')).toContain('123');
    expect(options).toMatchObject({
      timeout: 42,
      maxBuffer: 1024,
      windowsHide: true,
      env: { LC_ALL: 'C', TZ: 'UTC' },
    });
    expect(options.shell).toBeUndefined();
  });
  it.each([new Error('timeout'), new Error('permission denied'), null])(
    'treats failed or malformed probes as unknown (%s)',
    async (error) => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      mocks.execute.mockImplementation((_file, _args, _options, callback) =>
        callback(error, 'untrusted output', ''),
      );
      expect(await readAnalysisWriterBirth(123)).toBeUndefined();
    },
  );
  it('allows a Windows probe to finish after a slow PowerShell startup', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    vi.useFakeTimers();
    try {
      mocks.execute.mockImplementation((_file, _args, options, callback) => {
        const timeout = setTimeout(() => callback(new Error('timeout'), '', ''), options.timeout);
        setTimeout(() => {
          clearTimeout(timeout);
          callback(null, '639296533230000000', '');
        }, 2500);
      });
      const birth = readAnalysisWriterBirth(123);
      await vi.advanceTimersByTimeAsync(2500);
      expect(await birth).toEqual({ kind: 'win32-ticks', value: '639296533230000000' });
      expect(mocks.execute.mock.calls[0][2].timeout).toBeLessThanOrEqual(5000);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([0, -1, 1.2, NaN, Infinity])(
    'does not launch a probe for invalid PID %s',
    async (pid) => {
      expect(await readAnalysisWriterBirth(pid)).toBeUndefined();
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    {},
    { kind: 'win32-ticks', value: 'x' },
    { kind: 'linux-proc', value: 12 },
    { kind: 'other', value: '123' },
  ])('rejects malformed receipt identity %j', (value) => {
    expect(isAnalysisWriterBirth(value)).toBe(false);
  });
});
