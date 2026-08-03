/**
 * Unit Tests: GITNEXUS_TRUST_PROXY resolution
 *
 * Express accepts a boolean, a hop count, or a comma-separated proxy list for
 * `trust proxy`, and compiles the value inside `app.set` — so an unvalidated
 * env value takes the server down at startup, or (for a number it cannot
 * range-check) silently trusts every hop. resolveTrustProxy validates first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRUST_PROXY,
  MAX_TRUST_PROXY_HOPS,
  TRUST_PROXY_ENV,
  resolveTrustProxy,
} from '../../src/server/middleware.js';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';

// `logger` is a Proxy with only a `get` trap, so vi.spyOn cannot replace
// `warn` on it; the module's own capture helper redirects the destination.
let cap: LoggerCapture;
beforeEach(() => {
  cap = _captureLogger();
});
afterEach(() => {
  cap.restore();
});

const warnings = (): string[] =>
  cap
    .records()
    .filter((r) => r.level === 40)
    .map((r) => String(r.msg));

describe('resolveTrustProxy — accepted', () => {
  it('falls back to the loopback-scoped default when unset or blank', () => {
    expect(resolveTrustProxy(undefined)).toBe(DEFAULT_TRUST_PROXY);
    expect(resolveTrustProxy('')).toBe(DEFAULT_TRUST_PROXY);
    expect(resolveTrustProxy('   ')).toBe(DEFAULT_TRUST_PROXY);
    expect(warnings()).toEqual([]);
  });

  it('accepts the default it falls back to, so the fallback can never throw', () => {
    expect(() => resolveTrustProxy(DEFAULT_TRUST_PROXY)).not.toThrow();
    expect(resolveTrustProxy(DEFAULT_TRUST_PROXY)).toBe(DEFAULT_TRUST_PROXY);
    expect(warnings()).toEqual([]);
  });

  const hopCounts = Array.from({ length: MAX_TRUST_PROXY_HOPS }, (_, i) => i + 1);
  it.each(hopCounts)('accepts hop count %i', (hops) => {
    expect(() => resolveTrustProxy(String(hops))).not.toThrow();
    expect(resolveTrustProxy(String(hops))).toBe(hops);
    expect(warnings()).toEqual([]);
  });

  it('trims surrounding whitespace off a hop count', () => {
    expect(resolveTrustProxy(' 2 ')).toBe(2);
  });

  it.each([
    ['false', false],
    ['FALSE', false],
    ['no', false],
    ['NO', false],
    ['off', false],
    ['OFF', false],
  ] as const)('accepts %s as a boolean without warning', (raw, expected) => {
    expect(resolveTrustProxy(raw)).toBe(expected);
    expect(warnings()).toEqual([]);
  });

  it.each(['loopback', 'linklocal', 'uniquelocal', '10.0.0.0/8, 127.0.0.1'])(
    'accepts the proxy list %s verbatim',
    (raw) => {
      expect(() => resolveTrustProxy(raw)).not.toThrow();
      expect(resolveTrustProxy(raw)).toBe(raw);
      expect(warnings()).toEqual([]);
    },
  );
});

describe('resolveTrustProxy — warns on a trust-everything value', () => {
  it.each(['true', 'TRUE', 'yes', 'YES', 'on', 'ON'])('accepts %s but warns', (raw) => {
    expect(resolveTrustProxy(raw)).toBe(true);
    const warned = warnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(TRUST_PROXY_ENV);
    expect(warned[0]).toContain('X-Forwarded-For');
  });
});

describe('resolveTrustProxy — rejected', () => {
  it.each([
    ['garbage', 'an unknown subnet name'],
    ['*', 'a wildcard'],
    ['9'.repeat(400), 'a hop count that overflows to Infinity'],
    ['0', 'a hop count below the range'],
    [String(MAX_TRUST_PROXY_HOPS + 1), 'a hop count above the range'],
    ['-1', 'a negative hop count'],
    ['1.5', 'a fractional hop count'],
    ['a.com;b.com', 'a semicolon-separated list'],
  ])('falls back to the default on %#: %s', (raw) => {
    expect(resolveTrustProxy(raw)).toBe(DEFAULT_TRUST_PROXY);
    const warned = warnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(TRUST_PROXY_ENV);
    expect(warned[0]).toContain(raw);
  });
});

describe('resolveTrustProxy — contract', () => {
  it('names the env var it reads', () => {
    expect(TRUST_PROXY_ENV).toBe('GITNEXUS_TRUST_PROXY');
  });

  it('defaults to loopback plus the private ranges', () => {
    expect(DEFAULT_TRUST_PROXY).toBe('loopback, linklocal, uniquelocal');
  });
});
