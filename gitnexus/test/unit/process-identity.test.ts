import { afterEach, describe, expect, it, vi } from 'vitest';

import { isProcessAlive } from '../../src/utils/process-identity.js';

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
});
