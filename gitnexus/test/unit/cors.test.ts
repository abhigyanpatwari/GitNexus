/**
 * Unit Tests: CORS origin allowlist
 *
 * Tests isAllowedOrigin() from server/api.ts, which controls which HTTP
 * Origins are permitted by the Express CORS middleware.
 *
 * Policy:
 *   - No origin (non-browser)         → allowed
 *   - http://localhost:<port>          → allowed
 *   - http://127.0.0.1:<port>         → allowed
 *   - RFC 1918 private network ranges → allowed
 *       10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - https://gitnexus.vercel.app     → allowed
 *   - Everything else                 → rejected
 */
import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { isAllowedOrigin } from '../../src/server/api.js';
import { createPublicOriginMatcher } from '../../src/server/middleware.js';

// isAllowedOrigin consults GITNEXUS_PUBLIC_ORIGIN, so every expectation below
// assumes it is unset unless the test sets it. Clear the developer's ambient
// value for the file rather than inheriting it.
const ambientPublicOrigin = process.env.GITNEXUS_PUBLIC_ORIGIN;
beforeAll(() => {
  delete process.env.GITNEXUS_PUBLIC_ORIGIN;
});
afterAll(() => {
  if (ambientPublicOrigin !== undefined) process.env.GITNEXUS_PUBLIC_ORIGIN = ambientPublicOrigin;
});

// ─── No origin (non-browser / curl) ──────────────────────────────────

describe('isAllowedOrigin: no origin', () => {
  it('allows undefined origin (curl, server-to-server)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
  });
});

// ─── Localhost variants ───────────────────────────────────────────────

describe('isAllowedOrigin: localhost', () => {
  it('allows http://localhost:3000', () => {
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
  });

  it('allows http://localhost:5173 (Vite default)', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
  });

  it('allows http://localhost:8080', () => {
    expect(isAllowedOrigin('http://localhost:8080')).toBe(true);
  });

  it('allows http://127.0.0.1:3000', () => {
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
  });

  it('allows http://127.0.0.1:5173', () => {
    expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
  });
});

// ─── Deployed site ────────────────────────────────────────────────────

describe('isAllowedOrigin: vercel.app', () => {
  it('allows https://gitnexus.vercel.app', () => {
    expect(isAllowedOrigin('https://gitnexus.vercel.app')).toBe(true);
  });

  it('rejects other vercel.app subdomains', () => {
    expect(isAllowedOrigin('https://evil.vercel.app')).toBe(false);
  });
});

// ─── RFC 1918: 10.0.0.0/8 ────────────────────────────────────────────

describe('isAllowedOrigin: 10.x.x.x (RFC 1918, /8)', () => {
  it('allows http://10.0.0.1:3000', () => {
    expect(isAllowedOrigin('http://10.0.0.1:3000')).toBe(true);
  });

  it('allows http://10.1.2.3:5173', () => {
    expect(isAllowedOrigin('http://10.1.2.3:5173')).toBe(true);
  });

  it('allows http://10.255.255.255:8080', () => {
    expect(isAllowedOrigin('http://10.255.255.255:8080')).toBe(true);
  });
});

// ─── RFC 1918: 172.16.0.0/12 ─────────────────────────────────────────

describe('isAllowedOrigin: 172.16-31.x.x (RFC 1918, /12)', () => {
  it('allows http://172.16.0.1:3000 (lower bound)', () => {
    expect(isAllowedOrigin('http://172.16.0.1:3000')).toBe(true);
  });

  it('allows http://172.20.1.2:3000 (middle of range)', () => {
    expect(isAllowedOrigin('http://172.20.1.2:3000')).toBe(true);
  });

  it('allows http://172.31.255.255:3000 (upper bound)', () => {
    expect(isAllowedOrigin('http://172.31.255.255:3000')).toBe(true);
  });

  it('rejects http://172.15.0.1:3000 (below range)', () => {
    expect(isAllowedOrigin('http://172.15.0.1:3000')).toBe(false);
  });

  it('rejects http://172.32.0.1:3000 (above range)', () => {
    expect(isAllowedOrigin('http://172.32.0.1:3000')).toBe(false);
  });
});

// ─── RFC 1918: 192.168.0.0/16 ────────────────────────────────────────

describe('isAllowedOrigin: 192.168.x.x (RFC 1918, /16)', () => {
  it('allows http://192.168.0.1:3000 (typical home router gateway)', () => {
    expect(isAllowedOrigin('http://192.168.0.1:3000')).toBe(true);
  });

  it('allows http://192.168.1.100:5173', () => {
    expect(isAllowedOrigin('http://192.168.1.100:5173')).toBe(true);
  });

  it('allows http://192.168.255.254:8080', () => {
    expect(isAllowedOrigin('http://192.168.255.254:8080')).toBe(true);
  });

  it('rejects http://192.167.1.1:3000 (adjacent, not private)', () => {
    expect(isAllowedOrigin('http://192.167.1.1:3000')).toBe(false);
  });

  it('rejects http://192.169.1.1:3000 (adjacent, not private)', () => {
    expect(isAllowedOrigin('http://192.169.1.1:3000')).toBe(false);
  });
});

// ─── Public / untrusted origins ───────────────────────────────────────

describe('isAllowedOrigin: rejected origins', () => {
  it('rejects https://evil.com', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe(false);
  });

  it('rejects https://example.com', () => {
    expect(isAllowedOrigin('https://example.com')).toBe(false);
  });

  it('rejects http://8.8.8.8:3000 (Google DNS, public IP)', () => {
    expect(isAllowedOrigin('http://8.8.8.8:3000')).toBe(false);
  });

  it('rejects https://gitnexus.example.com (not the official domain)', () => {
    expect(isAllowedOrigin('https://gitnexus.example.com')).toBe(false);
  });

  it('rejects malformed origin string', () => {
    expect(isAllowedOrigin('not-a-url')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isAllowedOrigin('')).toBe(false);
  });

  // Localhost without explicit port (port 80 implied)
  it('allows http://localhost without port', () => {
    expect(isAllowedOrigin('http://localhost')).toBe(true);
  });

  it('allows http://127.0.0.1 without port', () => {
    expect(isAllowedOrigin('http://127.0.0.1')).toBe(true);
  });

  // IPv6 loopback
  it('allows IPv6 loopback http://[::1]:3000', () => {
    expect(isAllowedOrigin('http://[::1]:3000')).toBe(true);
  });

  it('allows IPv6 loopback http://[::1] without port', () => {
    expect(isAllowedOrigin('http://[::1]')).toBe(true);
  });

  // Protocol validation
  it('rejects non-HTTP(S) origins from private IPs', () => {
    expect(isAllowedOrigin('ftp://10.0.0.1')).toBe(false);
    expect(isAllowedOrigin('ftp://192.168.1.1')).toBe(false);
  });

  it('allows HTTP and HTTPS from private IPs', () => {
    expect(isAllowedOrigin('http://192.168.1.100')).toBe(true);
    expect(isAllowedOrigin('https://10.0.0.50')).toBe(true);
    expect(isAllowedOrigin('http://172.16.5.1:3000')).toBe(true);
  });
});

describe('isAllowedOrigin: GITNEXUS_PUBLIC_ORIGIN', () => {
  // Back to the file's cleared baseline, not to the ambient value afterAll
  // restores — the tests above assume it stays unset.
  afterEach(() => {
    delete process.env.GITNEXUS_PUBLIC_ORIGIN;
  });

  it('allows the configured origin as a full URL or a bare host', () => {
    process.env.GITNEXUS_PUBLIC_ORIGIN = 'https://app.example.com';
    expect(isAllowedOrigin('https://app.example.com')).toBe(true);
    process.env.GITNEXUS_PUBLIC_ORIGIN = 'app.example.com';
    expect(isAllowedOrigin('https://app.example.com')).toBe(true);
  });

  it('enforces the port when the configured value carries one', () => {
    process.env.GITNEXUS_PUBLIC_ORIGIN = 'https://app.example.com:8443';
    expect(isAllowedOrigin('https://app.example.com:8443')).toBe(true);
    expect(isAllowedOrigin('https://app.example.com:9999')).toBe(false);
    // The browser elides the default port, so a bare origin is port 443 here.
    expect(isAllowedOrigin('https://app.example.com')).toBe(false);
  });

  it('accepts any port when the configured value carries none', () => {
    process.env.GITNEXUS_PUBLIC_ORIGIN = 'app.example.com';
    expect(isAllowedOrigin('https://app.example.com')).toBe(true);
    expect(isAllowedOrigin('https://app.example.com:8443')).toBe(true);
    expect(isAllowedOrigin('https://app.example.com:9999')).toBe(true);
  });

  it('matches a configured default port against an origin that elides it', () => {
    process.env.GITNEXUS_PUBLIC_ORIGIN = 'https://app.example.com:443';
    expect(isAllowedOrigin('https://app.example.com')).toBe(true);
    expect(isAllowedOrigin('https://app.example.com:8443')).toBe(false);
  });

  it('handles a bracketed IPv6 literal with a port, with and without a scheme', () => {
    // No scheme means https, so the http probes below are scheme mismatches.
    process.env.GITNEXUS_PUBLIC_ORIGIN = '[2001:db8::1]:8080';
    expect(isAllowedOrigin('https://[2001:db8::1]:8080')).toBe(true);
    expect(isAllowedOrigin('https://[2001:db8::1]:9090')).toBe(false);
    expect(isAllowedOrigin('http://[2001:db8::1]:8080')).toBe(false);
    process.env.GITNEXUS_PUBLIC_ORIGIN = 'http://[2001:db8::1]:8080';
    expect(isAllowedOrigin('http://[2001:db8::1]:8080')).toBe(true);
    expect(isAllowedOrigin('https://[2001:db8::1]:8080')).toBe(false);
  });

  it('accepts any port on a bare IPv6 literal, which carries none', () => {
    process.env.GITNEXUS_PUBLIC_ORIGIN = '[2001:db8::1]';
    expect(isAllowedOrigin('https://[2001:db8::1]:4173')).toBe(true);
    // Non-canonical forms compress to the same hostname a browser Origin has.
    process.env.GITNEXUS_PUBLIC_ORIGIN = '2001:db8:0:0:0:0:0:1';
    expect(isAllowedOrigin('https://[2001:db8::1]:4173')).toBe(true);
  });

  it('does not widen to other hosts', () => {
    process.env.GITNEXUS_PUBLIC_ORIGIN = 'app.example.com';
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedOrigin('https://app.example.com.evil.com')).toBe(false);
  });

  it('enforces the scheme when the configured value carries one', () => {
    process.env.GITNEXUS_PUBLIC_ORIGIN = 'https://app.example.com';
    expect(isAllowedOrigin('http://app.example.com')).toBe(false);
  });

  // A bare host is the platform service-discovery form, and those terminate
  // TLS — so it means https, not either scheme. Accepting either would make it
  // an http downgrade path into the read allowlist and the write guard alike.
  it('reads a bare host as https, not as either scheme', () => {
    process.env.GITNEXUS_PUBLIC_ORIGIN = 'app.example.com';
    expect(isAllowedOrigin('https://app.example.com')).toBe(true);
    expect(isAllowedOrigin('http://app.example.com')).toBe(false);
  });

  it('accepts http on a bare host only when http:// is spelled out', () => {
    process.env.GITNEXUS_PUBLIC_ORIGIN = 'http://app.example.com';
    expect(isAllowedOrigin('http://app.example.com')).toBe(true);
    expect(isAllowedOrigin('https://app.example.com')).toBe(false);
  });

  it('still rejects non-http protocols on the configured host', () => {
    process.env.GITNEXUS_PUBLIC_ORIGIN = 'app.example.com';
    expect(isAllowedOrigin('ftp://app.example.com')).toBe(false);
  });

  it('is inert when unset', () => {
    delete process.env.GITNEXUS_PUBLIC_ORIGIN;
    expect(isAllowedOrigin('https://app.example.com')).toBe(false);
  });
});

// A value that yields a matcher no real Origin can satisfy is worse than no
// value at all: it reads as configured, so the wildcard-bind warning in
// createServer reports a working origin where there is none.
describe('createPublicOriginMatcher: values that are not one reachable host', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['*', 'a wildcard'],
    ['a.com,b.com', 'a comma-separated list'],
    ['a.com;b.com', 'a semicolon-separated list'],
    ['8080', 'a bare port number — new URL reads it as the integer IP 0.0.31.144'],
    ['under score', 'an embedded space'],
    ['a.com:99999', 'a port out of range'],
    ['a.com:0', 'port 0, which parses but which no browser ever sends'],
    ['https://a.com:00', 'port 00, which normalizes to 0 rather than to a default'],
    ['ftp://a.com', 'a non-http scheme'],
    ['https://a.com/ui', 'a path, which an Origin never has'],
    ['0.0.0.0', 'a wildcard bind, which has no host identity'],
    ['a.com.', 'a trailing dot — a legal FQDN, but not what a browser sends'],
    ['https://a.com.:8443', 'a trailing dot with a scheme and a port'],
  ])('returns undefined for %j (%s)', (raw) => {
    expect(createPublicOriginMatcher(raw)).toBeUndefined();
  });

  it('returns undefined when the env var is unset', () => {
    expect(createPublicOriginMatcher(undefined)).toBeUndefined();
  });
});

describe('createPublicOriginMatcher: values that resolve to one host', () => {
  it('tolerates the trailing slash a pasted URL carries', () => {
    const matcher = createPublicOriginMatcher('https://app.example.com/');
    expect(matcher?.hostname).toBe('app.example.com');
    expect(matcher?.matches(new URL('https://app.example.com'))).toBe(true);
  });

  // Guards the port-0 rejection above from over-reaching: a leading zero on a
  // real port normalizes to that port, not to 0.
  it('reads a leading-zero port as the port it normalizes to', () => {
    const matcher = createPublicOriginMatcher('http://a.com:0080');
    expect(matcher?.matches(new URL('http://a.com'))).toBe(true);
    expect(matcher?.matches(new URL('http://a.com:80'))).toBe(true);
    expect(matcher?.matches(new URL('http://a.com:8080'))).toBe(false);
  });

  it('reports the hostname it resolved, for the startup log line', () => {
    expect(createPublicOriginMatcher('https://App.Example.com:8443')?.hostname).toBe(
      'app.example.com',
    );
    expect(createPublicOriginMatcher('2001:db8:0:0:0:0:0:1')?.hostname).toBe('[2001:db8::1]');
  });
});
