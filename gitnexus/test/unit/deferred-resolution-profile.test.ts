import { afterEach, describe, expect, it } from 'vitest';
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

  it('profileElapsedMs returns non-negative ms', () => {
    const start = profileNow();
    const ms = profileElapsedMs(start);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(1000);
  });
});
