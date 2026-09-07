import { afterEach, describe, expect, it, vi } from 'vitest';

import { isProcessAlive, readProcessStartTime } from '../../src/utils/process-identity.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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
});
