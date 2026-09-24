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
  warnIfRateLimitKeysCollapse,
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

  // Express tests a hop count as `i < hops`, so 0 and false are the same
  // setting. Rejecting 0 would fall back to a default that trusts more.
  it('normalizes a hop count of 0 to false rather than rejecting it', () => {
    expect(resolveTrustProxy('0')).toBe(false);
    expect(warnings()).toEqual([]);
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

// `true` trusts every hop, which makes req.ip the client-controlled leftmost
// X-Forwarded-For entry — a fresh rate-limit key per spoofed request, in front
// of the two routes that spawn workers. express-rate-limit's own
// validations.trustProxy throws ERR_ERL_PERMISSIVE_TRUST_PROXY on it, so it was
// never a working configuration either. Rejected, not warned.
describe('resolveTrustProxy — rejects a trust-everything value', () => {
  it.each(['true', 'TRUE', 'yes', 'YES', 'on', 'ON'])('falls back to the default on %s', (raw) => {
    expect(resolveTrustProxy(raw)).toBe(DEFAULT_TRUST_PROXY);
    const warned = warnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(TRUST_PROXY_ENV);
    expect(warned[0]).toContain(raw);
    expect(warned[0]).toContain('X-Forwarded-For');
  });

  it('never returns true, so express-rate-limit cannot reject the value we set', () => {
    for (const raw of ['true', 'yes', 'on', 'TRUE', '1', '16', 'loopback', '0', 'false']) {
      expect(resolveTrustProxy(raw)).not.toBe(true);
    }
  });
});

describe('resolveTrustProxy — rejected', () => {
  it.each([
    ['garbage', 'an unknown subnet name'],
    ['*', 'a wildcard'],
    ['9'.repeat(400), 'a hop count that overflows to Infinity'],
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

// resolveTrustProxy sees only the env value; whether the default is about to
// collapse the per-IP rate limit to one global limit depends on what we bound.
describe('warnIfRateLimitKeysCollapse', () => {
  const original = process.env[TRUST_PROXY_ENV];
  beforeEach(() => {
    delete process.env[TRUST_PROXY_ENV];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[TRUST_PROXY_ENV];
    else process.env[TRUST_PROXY_ENV] = original;
  });

  it.each(['localhost', '127.0.0.1', '::1', '[::1]'])('stays silent on a %s bind', (host) => {
    warnIfRateLimitKeysCollapse(host);
    expect(warnings()).toEqual([]);
  });

  it.each([undefined, ''])('stays silent when no host is given (%o)', (host) => {
    warnIfRateLimitKeysCollapse(host);
    expect(warnings()).toEqual([]);
  });

  it.each([
    ['0.0.0.0', 'a wildcard bind accepts LB traffic too'],
    ['::', 'the IPv6 wildcard likewise'],
    ['192.168.1.10', 'a LAN bind'],
    ['203.0.113.7', 'a public bind'],
  ])('warns on %s (%s)', (host) => {
    warnIfRateLimitKeysCollapse(host);
    const warned = warnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(TRUST_PROXY_ENV);
    expect(warned[0]).toContain(host);
    expect(warned[0]).toContain('one shared limit');
  });

  it.each(['1', 'loopback', 'garbage'])(
    'stays silent when %s is configured, valid or not',
    (raw) => {
      // An invalid value is resolveTrustProxy's warning to make, not a second one
      // here — the operator has already been told about that value.
      process.env[TRUST_PROXY_ENV] = raw;
      warnIfRateLimitKeysCollapse('0.0.0.0');
      expect(warnings()).toEqual([]);
    },
  );

  it('treats a whitespace-only value as unset', () => {
    process.env[TRUST_PROXY_ENV] = '   ';
    warnIfRateLimitKeysCollapse('0.0.0.0');
    expect(warnings()).toHaveLength(1);
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
