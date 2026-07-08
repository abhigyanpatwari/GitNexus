import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  alwaysOnSlowFileWarnMs,
  deferredCallFileSlowMs,
  deferredCallLogEveryN,
  endTimer,
  getDeferredProfileDroppedCount,
  isDeferredResolutionProfileEnabled,
  logDeferredProfile,
  profileElapsedMs,
  profileNow,
  resetDeferredProfileDroppedCount,
  startTimer,
} from '../../src/core/ingestion/utils/deferred-resolution-profile.js';
import { _captureLogger } from '../../src/core/logger.js';

describe('deferred-resolution-profile', () => {
  afterEach(() => {
    delete process.env.GITNEXUS_PROFILE_DEFERRED;
    delete process.env.GITNEXUS_PROFILE_DEFERRED_SLOW_MS;
    delete process.env.GITNEXUS_SLOW_FILE_WARN_MS;
    delete process.env.GITNEXUS_VERBOSE;
    resetDeferredProfileDroppedCount();
    vi.restoreAllMocks();
  });

  describe('alwaysOnSlowFileWarnMs (#1741 always-on watchdog)', () => {
    it('defaults to 15s and is NOT gated on verbose/profile', () => {
      expect(alwaysOnSlowFileWarnMs()).toBe(15_000);
      // Still 15s even with profiling fully off — the whole point is always-on.
      expect(isDeferredResolutionProfileEnabled()).toBe(false);
    });

    it('reads a positive override from GITNEXUS_SLOW_FILE_WARN_MS', () => {
      process.env.GITNEXUS_SLOW_FILE_WARN_MS = '2000';
      expect(alwaysOnSlowFileWarnMs()).toBe(2000);
    });

    it('treats 0 / negative / non-numeric as disabled (0)', () => {
      process.env.GITNEXUS_SLOW_FILE_WARN_MS = '0';
      expect(alwaysOnSlowFileWarnMs()).toBe(0);
      process.env.GITNEXUS_SLOW_FILE_WARN_MS = '-5';
      expect(alwaysOnSlowFileWarnMs()).toBe(0);
      process.env.GITNEXUS_SLOW_FILE_WARN_MS = 'nope';
      expect(alwaysOnSlowFileWarnMs()).toBe(0);
    });

    it('does not prefix-parse exponent notation into a tiny value', () => {
      // Number('1e9') === 1e9 (unlike parseInt('1e9',10) === 1).
      process.env.GITNEXUS_SLOW_FILE_WARN_MS = '1e9';
      expect(alwaysOnSlowFileWarnMs()).toBe(1_000_000_000);
    });
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

  describe('logDeferredProfile dropped-line counter (U4)', () => {
    // Background: `logger` (gitnexus/src/core/logger.ts) is a Proxy with a lazy
    // `get` trap and no `set` trap, so vi.spyOn on `logger.info` fails with
    // "property is not defined on the object" — the inner pino method isn't a
    // stable own-property to wrap. These tests exercise the helper API and the
    // happy path; the catch arm is pinned by source-shape assertions below.

    it('counter is zero at module entry (after reset in afterEach)', () => {
      expect(getDeferredProfileDroppedCount()).toBe(0);
    });

    it('does not increment when logger.info succeeds', () => {
      const cap = _captureLogger();
      try {
        logDeferredProfile('normal message');
        expect(getDeferredProfileDroppedCount()).toBe(0);
      } finally {
        cap.restore();
      }
    });

    it('multiple successful calls keep the counter at zero', () => {
      const cap = _captureLogger();
      try {
        logDeferredProfile('m1');
        logDeferredProfile('m2');
        logDeferredProfile('m3');
        expect(getDeferredProfileDroppedCount()).toBe(0);
      } finally {
        cap.restore();
      }
    });

    it('resetDeferredProfileDroppedCount returns the counter to zero', () => {
      // Drive the counter via a stub since we can't spy on the Proxy.
      // Mutate the counter through the public API: simulate a dropped line
      // by calling logDeferredProfile inside a forced-throw context.
      // Without a way to force logger.info to throw, the most we can test
      // here is that reset() is idempotent on an already-zero counter and
      // that the getter reads what reset wrote.
      resetDeferredProfileDroppedCount();
      expect(getDeferredProfileDroppedCount()).toBe(0);
      resetDeferredProfileDroppedCount();
      expect(getDeferredProfileDroppedCount()).toBe(0);
    });

    it('source defines a try/catch around the logger.info call', () => {
      // Pin the catch arm via source shape — see logger Proxy note above.
      const fs = require('node:fs') as typeof import('node:fs');
      const path = require('node:path') as typeof import('node:path');
      const url = require('node:url') as typeof import('node:url');
      const here = path.dirname(url.fileURLToPath(import.meta.url));
      const sourcePath = path.resolve(
        here,
        '../../src/core/ingestion/utils/deferred-resolution-profile.ts',
      );
      const source = fs.readFileSync(sourcePath, 'utf-8');

      expect(
        /export const logDeferredProfile[\s\S]*?try \{\s*logger\.info\(`\[deferred-profile\] \$\{message\}`\);\s*\} catch[\s\S]*?droppedLogLines\+\+/.test(
          source,
        ),
      ).toBe(true);
    });
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
