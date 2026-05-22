import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deferredCallFileSlowMs,
  deferredCallLogEveryN,
  endTimer,
  isDeferredResolutionProfileEnabled,
  profileElapsedMs,
  profileNow,
  startTimer,
} from '../../src/core/ingestion/utils/deferred-resolution-profile.js';
import { _captureLogger } from '../../src/core/logger.js';

describe('deferred-resolution-profile', () => {
  afterEach(() => {
    delete process.env.GITNEXUS_PROFILE_DEFERRED;
    delete process.env.GITNEXUS_PROFILE_DEFERRED_SLOW_MS;
    delete process.env.GITNEXUS_VERBOSE;
  });

  it('is off by default', () => {
    expect(isDeferredResolutionProfileEnabled()).toBe(false);
  });

  it('enables on GITNEXUS_VERBOSE=1', () => {
    process.env.GITNEXUS_VERBOSE = '1';
    expect(isDeferredResolutionProfileEnabled()).toBe(true);
    expect(deferredCallLogEveryN()).toBe(10);
    expect(deferredCallFileSlowMs()).toBe(3000);
  });

  it('enables on GITNEXUS_PROFILE_DEFERRED=1', () => {
    process.env.GITNEXUS_PROFILE_DEFERRED = '1';
    expect(isDeferredResolutionProfileEnabled()).toBe(true);
    expect(deferredCallLogEveryN()).toBe(100);
  });

  it('reads slow-file threshold from env', () => {
    process.env.GITNEXUS_PROFILE_DEFERRED_SLOW_MS = '250';
    expect(deferredCallFileSlowMs()).toBe(250);
  });

  describe('endTimer (U3 formatter exception safety)', () => {
    it('emits the formatter output via [deferred-profile] when start is non-null', () => {
      const cap = _captureLogger();
      try {
        const start = startTimer(true);
        endTimer(start, (ms) => `stage A: ${ms.toFixed(0)}ms`);
        const messages = cap.records().map((r) => String(r.msg ?? ''));
        expect(messages.some((m) => /\[deferred-profile\] stage A: \d+ms/.test(m))).toBe(true);
      } finally {
        cap.restore();
      }
    });

    it('is a no-op when start is null (profiling disabled), even if formatter would throw', () => {
      const cap = _captureLogger();
      try {
        const formatter = vi.fn(() => {
          throw new Error('should never run');
        });
        endTimer(null, formatter);
        expect(formatter).not.toHaveBeenCalled();
        expect(cap.records()).toEqual([]);
      } finally {
        cap.restore();
      }
    });

    it('catches a throwing formatter and emits one formatter-error line', () => {
      const cap = _captureLogger();
      try {
        const start = startTimer(true);
        expect(() =>
          endTimer(start, () => {
            throw new Error('boom');
          }),
        ).not.toThrow();

        const messages = cap.records().map((r) => String(r.msg ?? ''));
        const errLines = messages.filter((m) =>
          m.includes('[deferred-profile] formatter error: boom'),
        );
        expect(errLines.length).toBe(1);
      } finally {
        cap.restore();
      }
    });

    it('coerces non-Error throws (string, plain object) via String() in the error message', () => {
      const cap = _captureLogger();
      try {
        const start = startTimer(true);
        endTimer(start, () => {
          throw 'plain string';
        });
        const messages = cap.records().map((r) => String(r.msg ?? ''));
        expect(
          messages.some((m) => m.includes('[deferred-profile] formatter error: plain string')),
        ).toBe(true);
      } finally {
        cap.restore();
      }
    });
  });

  it('profileElapsedMs converts hrtime deltas to ms with exact arithmetic', () => {
    const spy = vi.spyOn(process.hrtime, 'bigint');
    try {
      spy.mockReturnValueOnce(1_000_000_000n);
      const start = profileNow();
      spy.mockReturnValueOnce(1_002_500_000n);
      expect(profileElapsedMs(start)).toBe(2.5);

      spy.mockReturnValueOnce(5_000_000_000n);
      const startZero = profileNow();
      spy.mockReturnValueOnce(5_000_000_000n);
      expect(profileElapsedMs(startZero)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
