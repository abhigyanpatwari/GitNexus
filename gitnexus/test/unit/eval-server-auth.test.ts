import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSecureEvalServerBinding,
  isEvalServerBearerAuthorized,
  isEvalServerLoopbackHost,
  resolveEvalServerAuthToken,
  resolveEvalServerAuthTokenForHost,
  resolveEvalServerBindHost,
} from '../../src/cli/eval-server.js';

describe('eval-server bearer authentication', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a trimmed token and treats blank values as absent', () => {
    expect(resolveEvalServerAuthToken({ GITNEXUS_AUTH_TOKEN: '  secret-value  ' })).toBe(
      'secret-value',
    );
    expect(resolveEvalServerAuthToken({ GITNEXUS_AUTH_TOKEN: '' })).toBeUndefined();
    expect(resolveEvalServerAuthToken({ GITNEXUS_AUTH_TOKEN: '   ' })).toBeUndefined();
  });

  it('loads .env.local before .env while preserving explicit shell values', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-eval-auth-'));
    tempDirs.push(cwd);
    writeFileSync(path.join(cwd, '.env'), 'GITNEXUS_AUTH_TOKEN=from-env\n');
    writeFileSync(path.join(cwd, '.env.local'), 'GITNEXUS_AUTH_TOKEN=from-local\n');

    expect(resolveEvalServerAuthToken({}, cwd)).toBe('from-local');
    expect(resolveEvalServerAuthToken({ GITNEXUS_AUTH_TOKEN: 'from-shell' }, cwd)).toBe(
      'from-shell',
    );
    expect(resolveEvalServerAuthToken({ GITNEXUS_AUTH_TOKEN: '' }, cwd)).toBeUndefined();
  });

  it('defers an unreadable env file on loopback and stays fail-closed for remote binds', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-eval-auth-'));
    tempDirs.push(cwd);
    mkdirSync(path.join(cwd, '.env.local'));

    const loopback = resolveEvalServerAuthTokenForHost('127.0.0.1', {}, cwd);
    expect(loopback.token).toBeUndefined();
    expect(loopback.warning).toMatch(/Unable to read eval-server authentication/i);
    expect(loopback.warning).toMatch(/loopback/i);

    expect(() => resolveEvalServerAuthTokenForHost('0.0.0.0', {}, cwd)).toThrow(
      /Unable to read eval-server authentication/i,
    );
  });

  it('resolves the token for a host without touching files when the shell provides it', () => {
    const resolved = resolveEvalServerAuthTokenForHost('0.0.0.0', {
      GITNEXUS_AUTH_TOKEN: 'from-shell',
    });
    expect(resolved).toEqual({ token: 'from-shell' });
  });

  it('falls back to .env when .env.local is absent', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-eval-auth-'));
    tempDirs.push(cwd);
    writeFileSync(path.join(cwd, '.env'), 'GITNEXUS_AUTH_TOKEN="from env"\n');

    expect(resolveEvalServerAuthToken({}, cwd)).toBe('from env');
  });

  it('resolves DNS bind names to the concrete IPv4 used for the security decision', async () => {
    const resolveHostname = async (hostname: string) => {
      expect(hostname).toBe('devbox.local');
      return '192.168.1.50';
    };

    await expect(resolveEvalServerBindHost('devbox.local', resolveHostname)).resolves.toBe(
      '192.168.1.50',
    );
    await expect(resolveEvalServerBindHost('devbox.local', async () => '::1')).resolves.toBeNull();
    await expect(resolveEvalServerBindHost('not a hostname', resolveHostname)).resolves.toBeNull();
  });

  it('preserves literal IP addresses without a DNS lookup', async () => {
    let lookupCalled = false;
    await expect(
      resolveEvalServerBindHost('10.0.0.2', async () => {
        lookupCalled = true;
        return '127.0.0.1';
      }),
    ).resolves.toBe('10.0.0.2');
    expect(lookupCalled).toBe(false);
  });

  it.each(['127.0.0.1', '127.0.0.2', 'localhost', '::1'])('classifies %s as loopback', (host) => {
    expect(isEvalServerLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.50', '2001:db8::1', 'localhost.evil.test'])(
    'classifies %s as non-loopback',
    (host) => {
      expect(isEvalServerLoopbackHost(host)).toBe(false);
    },
  );

  it('allows loopback without a token and requires one for non-loopback binds', () => {
    expect(() => assertSecureEvalServerBinding('127.0.0.1', undefined)).not.toThrow();
    expect(() => assertSecureEvalServerBinding('::1', undefined)).not.toThrow();
    expect(() => assertSecureEvalServerBinding('0.0.0.0', 'secret-value')).not.toThrow();
    expect(() => assertSecureEvalServerBinding('192.168.1.50', undefined)).toThrow(
      /non-loopback.*GITNEXUS_AUTH_TOKEN/i,
    );
  });

  it('accepts only the exact Bearer header when a token is configured', () => {
    const token = 'secret-value';
    expect(isEvalServerBearerAuthorized(undefined, undefined)).toBe(true);
    expect(isEvalServerBearerAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(isEvalServerBearerAuthorized(undefined, token)).toBe(false);
    expect(isEvalServerBearerAuthorized(`Bearer wrong`, token)).toBe(false);
    expect(isEvalServerBearerAuthorized(token, token)).toBe(false);
    expect(isEvalServerBearerAuthorized(`bearer ${token}`, token)).toBe(false);
    expect(isEvalServerBearerAuthorized([`Bearer ${token}`], token)).toBe(false);
  });
});
