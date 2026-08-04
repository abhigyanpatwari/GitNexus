/**
 * Unit Tests: the write-route origin guard's port awareness, and what it
 * reports at startup.
 *
 * cors.test.ts covers the read side (isAllowedOrigin) of the same matcher.
 * This file covers the write side — createWriteOriginGuard — where a
 * mismatch is a 403 rather than a missing CORS header, plus the port-aware
 * bound-host comparison and logOriginPolicy's startup diagnostics.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PUBLIC_ORIGIN_ENV,
  createWriteOriginGuard,
  logOriginPolicy,
} from '../../src/server/middleware.js';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';

const savedPublicOrigin = process.env[PUBLIC_ORIGIN_ENV];

afterEach(() => {
  if (savedPublicOrigin === undefined) delete process.env[PUBLIC_ORIGIN_ENV];
  else process.env[PUBLIC_ORIGIN_ENV] = savedPublicOrigin;
});

function setPublicOrigin(value: string | undefined): void {
  if (value === undefined) delete process.env[PUBLIC_ORIGIN_ENV];
  else process.env[PUBLIC_ORIGIN_ENV] = value;
}

interface GuardResult {
  passed: boolean;
  status: number;
  body?: { error?: string; code?: string };
}

// The guard snapshots the env var at construction, so callers set it first.
function callGuard(
  boundHost: string | undefined,
  boundPort: number | undefined,
  origin: string,
): GuardResult {
  const guard = createWriteOriginGuard(boundHost, boundPort);
  let passed = false;
  let status = 0;
  let body: { error?: string; code?: string } | undefined;
  const req = { headers: { origin } } as never;
  const res = {
    status: (c: number) => {
      status = c;
      return {
        json: (b: { error?: string; code?: string }) => {
          body = b;
        },
      };
    },
  } as never;
  guard(req, res, () => {
    passed = true;
  });
  return { passed, status, body };
}

describe('createWriteOriginGuard — bound host is matched on its port', () => {
  it('admits the bound host on the bound port', () => {
    expect(callGuard('192.168.1.10', 8443, 'http://192.168.1.10:8443').passed).toBe(true);
  });

  it('rejects the bound host on a different port with origin_not_allowed', () => {
    const res = callGuard('192.168.1.10', 8443, 'http://192.168.1.10:9999');
    expect(res.passed).toBe(false);
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe('origin_not_allowed');
  });

  it('rejects the bound host on the default port when it is not the bound one', () => {
    // The pre-existing bug: `hostname === normalizedBoundHost` matched here.
    expect(callGuard('192.168.1.10', 8443, 'http://192.168.1.10').passed).toBe(false);
    expect(callGuard('192.168.1.10', 8443, 'https://192.168.1.10').passed).toBe(false);
  });

  it('treats an elided default port as that port', () => {
    expect(callGuard('192.168.1.10', 80, 'http://192.168.1.10').passed).toBe(true);
    expect(callGuard('192.168.1.10', 443, 'https://192.168.1.10').passed).toBe(true);
    expect(callGuard('192.168.1.10', 80, 'https://192.168.1.10').passed).toBe(false);
  });

  it('matches any port when no bound port is given', () => {
    expect(callGuard('192.168.1.10', undefined, 'http://192.168.1.10:9999').passed).toBe(true);
  });

  it('keeps loopback port-agnostic — the dev UI runs on its own port', () => {
    expect(callGuard('192.168.1.10', 8443, 'http://localhost:5173').passed).toBe(true);
    expect(callGuard('192.168.1.10', 8443, 'http://127.0.0.1:4173').passed).toBe(true);
    expect(callGuard('192.168.1.10', 8443, 'http://[::1]:4173').passed).toBe(true);
  });
});

describe('createWriteOriginGuard — public origin is matched on its port', () => {
  it('admits an exact scheme/host/port match on a wildcard bind', () => {
    setPublicOrigin('https://app.example.com:8443');
    expect(callGuard('0.0.0.0', 3000, 'https://app.example.com:8443').passed).toBe(true);
  });

  it('rejects a port mismatch with a 403 and origin_not_allowed', () => {
    setPublicOrigin('https://app.example.com:8443');
    const res = callGuard('0.0.0.0', 3000, 'https://app.example.com:9999');
    expect(res.passed).toBe(false);
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe('origin_not_allowed');
  });

  it('rejects a scheme mismatch when the configured value carries a scheme', () => {
    setPublicOrigin('https://app.example.com');
    expect(callGuard('0.0.0.0', 3000, 'http://app.example.com').passed).toBe(false);
  });

  it('admits any scheme and port for a bare configured host', () => {
    setPublicOrigin('app.example.com');
    expect(callGuard('0.0.0.0', 3000, 'http://app.example.com:9999').passed).toBe(true);
    expect(callGuard('0.0.0.0', 3000, 'https://app.example.com').passed).toBe(true);
  });

  it('admits a bracketed IPv6 literal, on any port when configured without one', () => {
    setPublicOrigin('[2001:db8::1]');
    expect(callGuard('0.0.0.0', 3000, 'http://[2001:db8::1]:4173').passed).toBe(true);
    setPublicOrigin('[2001:db8::1]:8080');
    expect(callGuard('0.0.0.0', 3000, 'http://[2001:db8::1]:8080').passed).toBe(true);
    expect(callGuard('0.0.0.0', 3000, 'http://[2001:db8::1]:4173').passed).toBe(false);
  });

  it('admits nothing extra when the configured value is not one reachable host', () => {
    setPublicOrigin('a.com,b.com');
    expect(callGuard('0.0.0.0', 3000, 'https://a.com').passed).toBe(false);
    expect(callGuard('0.0.0.0', 3000, 'https://b.com').passed).toBe(false);
  });

  it('leaves the Origin-less passthrough alone — the CLI sends no Origin', () => {
    setPublicOrigin('app.example.com');
    const guard = createWriteOriginGuard('0.0.0.0', 3000);
    let passed = false;
    guard({ headers: {} } as never, {} as never, () => {
      passed = true;
    });
    expect(passed).toBe(true);
  });
});

describe('logOriginPolicy', () => {
  let cap: LoggerCapture;
  beforeEach(() => {
    cap = _captureLogger();
  });
  afterEach(() => {
    cap.restore();
  });

  const infos = () => cap.records().filter((r) => r.level === 30);
  const warns = () => cap.records().filter((r) => r.level === 40);

  it('says nothing on a specific bind with no public origin', () => {
    setPublicOrigin(undefined);
    logOriginPolicy('192.168.1.10');
    expect(cap.records()).toEqual([]);
  });

  it('names the resolved hostname at info when a public origin is configured', () => {
    setPublicOrigin('https://App.Example.com:8443');
    logOriginPolicy('192.168.1.10');
    expect(infos()).toHaveLength(1);
    expect(String(infos()[0].msg)).toContain('app.example.com');
    expect(infos()[0].hostname).toBe('app.example.com');
    expect(warns()).toEqual([]);
  });

  // The four-way matrix: wildcard bind × public origin absent/valid/invalid.
  it('warns on a wildcard bind with no public origin, pointing at both remedies', () => {
    setPublicOrigin(undefined);
    logOriginPolicy('0.0.0.0');
    expect(warns()).toHaveLength(1);
    expect(String(warns()[0].msg)).toContain('wildcard address (0.0.0.0)');
    expect(String(warns()[0].msg)).toContain('--host');
    expect(String(warns()[0].msg)).toContain(PUBLIC_ORIGIN_ENV);
  });

  it('still warns on a wildcard bind with a valid public origin, and names it', () => {
    setPublicOrigin('https://app.example.com');
    logOriginPolicy('::');
    expect(infos()).toHaveLength(1);
    expect(warns()).toHaveLength(1);
    expect(String(warns()[0].msg)).toContain('app.example.com');
  });

  it('diagnoses an unusable public origin rather than reporting one', () => {
    setPublicOrigin('a.com,b.com');
    logOriginPolicy('0.0.0.0');
    expect(infos()).toEqual([]);
    // One for the unusable value, one for the wildcard bind it fails to rescue.
    expect(warns()).toHaveLength(2);
    expect(String(warns()[0].msg)).toContain('a.com,b.com');
    expect(String(warns()[1].msg)).toContain('--host');
  });

  it('diagnoses an unusable public origin on a specific bind too', () => {
    setPublicOrigin('*');
    logOriginPolicy('192.168.1.10');
    expect(warns()).toHaveLength(1);
    expect(String(warns()[0].msg)).toContain(PUBLIC_ORIGIN_ENV);
  });
});
