import { afterEach, describe, expect, it, vi } from 'vitest';

import { isProcessAlive, readProcessStartTime } from '../../src/utils/process-identity.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:child_process');
  vi.resetModules();
});

/**
 * Loads a fresh copy of the module (fresh memo) over a counted `execFileSync`,
 * so "how many times did we actually shell out" is observable. `doMock` is not
 * hoisted, so the statically imported functions used by the other tests keep
 * the real implementation.
 */
async function withCountedProbe(probe: () => string) {
  const execFileSync = vi.fn(probe);
  vi.doMock('node:child_process', () => ({ execFileSync }));
  vi.resetModules();
  const identity = await import('../../src/utils/process-identity.js');
  return { execFileSync, readProcessStartTimeCached: identity.readProcessStartTimeCached };
}

describe('process identity', () => {
  it('treats only ESRCH as a dead process', () => {
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });

    expect(isProcessAlive(111)).toBe(false);
    expect(isProcessAlive(222)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'renders the same start time regardless of the ambient timezone',
    () => {
      const original = process.env.TZ;
      try {
        process.env.TZ = 'UTC';
        const utc = readProcessStartTime(process.pid);
        process.env.TZ = 'Asia/Tokyo';
        const tokyo = readProcessStartTime(process.pid);

        expect(utc).toBeTruthy();
        // A locale/timezone-dependent identity makes a live lock look reused.
        expect(tokyo).toBe(utc);
      } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      }
    },
  );

  it('probes this process once and re-probes a foreign pid every time', async () => {
    const { execFileSync, readProcessStartTimeCached } = await withCountedProbe(() => 'STAMP\n');

    expect(readProcessStartTimeCached(process.pid)).toBe('STAMP');
    expect(readProcessStartTimeCached(process.pid)).toBe('STAMP');
    // On Windows each probe is a powershell.exe spawn plus a WMI query.
    expect(execFileSync).toHaveBeenCalledTimes(1);

    // A foreign process can exit and its pid be reused — caching that stamp
    // would blind the reuse check the stamp exists for.
    expect(readProcessStartTimeCached(process.pid + 1)).toBe('STAMP');
    expect(readProcessStartTimeCached(process.pid + 1)).toBe('STAMP');
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it('retries after a failed self probe instead of caching the failure', async () => {
    const { execFileSync, readProcessStartTimeCached } = await withCountedProbe(() => 'STAMP\n');
    execFileSync.mockImplementationOnce(() => {
      throw new Error('probe unavailable');
    });

    // A cached failure would leave acquireFileLock throwing "Unable to
    // determine process start time" for the rest of the process's life.
    expect(readProcessStartTimeCached(process.pid)).toBeUndefined();
    expect(readProcessStartTimeCached(process.pid)).toBe('STAMP');
    expect(readProcessStartTimeCached(process.pid)).toBe('STAMP');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
