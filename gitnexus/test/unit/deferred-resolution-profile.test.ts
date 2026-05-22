import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deferredCallFileSlowMs,
  deferredCallLogEveryN,
  isDeferredResolutionProfileEnabled,
  profileElapsedMs,
  profileNow,
} from '../../src/core/ingestion/utils/deferred-resolution-profile.js';

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
