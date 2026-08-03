/**
 * Unit Tests: GITNEXUS_TRUST_PROXY resolution
 *
 * Express accepts a boolean, a hop count, or a comma-separated list for
 * `trust proxy`. The env var arrives as a string, so it is coerced here.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRUST_PROXY,
  TRUST_PROXY_ENV,
  resolveTrustProxy,
} from '../../src/server/middleware.js';

describe('resolveTrustProxy', () => {
  it('falls back to the loopback-scoped default when unset or blank', () => {
    expect(resolveTrustProxy(undefined)).toBe(DEFAULT_TRUST_PROXY);
    expect(resolveTrustProxy('')).toBe(DEFAULT_TRUST_PROXY);
    expect(resolveTrustProxy('   ')).toBe(DEFAULT_TRUST_PROXY);
  });

  it('coerces a hop count to a number', () => {
    expect(resolveTrustProxy('1')).toBe(1);
    expect(resolveTrustProxy(' 2 ')).toBe(2);
  });

  it('coerces true/false to booleans, case-insensitively', () => {
    expect(resolveTrustProxy('true')).toBe(true);
    expect(resolveTrustProxy('TRUE')).toBe(true);
    expect(resolveTrustProxy('false')).toBe(false);
  });

  it('passes any other value through for Express to interpret', () => {
    expect(resolveTrustProxy('loopback')).toBe('loopback');
    expect(resolveTrustProxy('10.0.0.0/8, 127.0.0.1')).toBe('10.0.0.0/8, 127.0.0.1');
  });

  it('names the env var it reads', () => {
    expect(TRUST_PROXY_ENV).toBe('GITNEXUS_TRUST_PROXY');
  });
});
