import { describe, expect, it } from 'vitest';
import { resolveRegisteredRepoEntry } from '../../src/server/api.js';
import type { RegistryEntry } from '../../src/storage/repo-manager.js';

const entry = (overrides: Partial<RegistryEntry>): RegistryEntry => ({
  name: 'repo',
  path: '/tmp/repo',
  storagePath: '/tmp/repo/.gitnexus',
  indexedAt: '2026-07-09T00:00:00.000Z',
  lastCommit: 'deadbeef',
  ...overrides,
});

describe('resolveRegisteredRepoEntry', () => {
  it('resolves an explicit alias by exact registry path before basename fallback', () => {
    const aliased = entry({
      name: 'e2e-mini-repo',
      path: '/tmp/gitnexus-e2e-repo',
      storagePath: '/tmp/gitnexus-e2e-repo/.gitnexus',
    });

    expect(resolveRegisteredRepoEntry([aliased], '/tmp/gitnexus-e2e-repo')).toBe(aliased);
  });

  it('falls back to basename/name matching for older callers', () => {
    const repo = entry({ name: 'e2e-mini-repo' });

    expect(resolveRegisteredRepoEntry([repo], 'e2e-mini-repo')).toBe(repo);
    expect(resolveRegisteredRepoEntry([repo], 'E2E-MINI-REPO')).toBe(repo);
  });

  it('does not fall back to a duplicate basename after a path-shaped miss', () => {
    const first = entry({
      name: 'service',
      path: '/tmp/first/service',
      storagePath: '/tmp/first/service/.gitnexus',
    });
    const second = entry({
      name: 'service',
      path: '/tmp/second/service',
      storagePath: '/tmp/second/service/.gitnexus',
    });

    expect(resolveRegisteredRepoEntry([first, second], '/tmp/missing/service')).toBeNull();
    expect(resolveRegisteredRepoEntry([first, second], '/tmp/second/service')).toBe(second);
  });

  it('fails closed on relative slash input instead of basename fallback', () => {
    const named = entry({
      name: 'name',
      path: '/tmp/org/name',
      storagePath: '/tmp/org/name/.gitnexus',
    });

    expect(resolveRegisteredRepoEntry([named], 'org/name')).toBeNull();
  });

  it('fails closed on dot-relative input instead of name fallback', () => {
    const repo = entry({ name: 'repo' });

    expect(resolveRegisteredRepoEntry([repo], './repo')).toBeNull();
  });

  it('returns the first-registered entry when a bare name matches two entries', () => {
    // Documented legacy first-wins behavior: bare display names are ambiguous
    // across duplicate-name registrations, and the resolver deliberately keeps
    // returning the earliest registry entry (callers needing precision pass a path).
    const first = entry({
      name: 'reels',
      path: '/tmp/group-a/reels',
      storagePath: '/tmp/group-a/reels/.gitnexus',
    });
    const second = entry({
      name: 'reels',
      path: '/tmp/group-b/reels',
      storagePath: '/tmp/group-b/reels/.gitnexus',
    });

    expect(resolveRegisteredRepoEntry([first, second], 'reels')).toBe(first);
  });

  it('treats Windows-shaped input as a path claim and never falls back to basename', () => {
    // The backslash makes 'C:\ws\reels' a path claim, so canonicalization must
    // miss and the resolver must return null — NOT the same-named 'reels' entry.
    // This expectation is platform-unconditional: on POSIX the drive-letter path
    // canonicalizes to a nonexistent cwd-relative path, and on Windows CI
    // C:\ws\reels genuinely does not exist, so both platforms must yield null.
    const reels = entry({
      name: 'reels',
      path: '/tmp/reels',
      storagePath: '/tmp/reels/.gitnexus',
    });

    expect(resolveRegisteredRepoEntry([reels], 'C:\\ws\\reels')).toBeNull();
  });

  it('defaults to the first registered repo when no name is requested', () => {
    const first = entry({
      name: 'alpha',
      path: '/tmp/alpha',
      storagePath: '/tmp/alpha/.gitnexus',
    });
    const second = entry({
      name: 'beta',
      path: '/tmp/beta',
      storagePath: '/tmp/beta/.gitnexus',
    });

    expect(resolveRegisteredRepoEntry([first, second], undefined)).toBe(first);
  });

  it('returns null for an empty registry when no name is requested', () => {
    expect(resolveRegisteredRepoEntry([], undefined)).toBeNull();
  });

  it('matches a bare name case-insensitively when no exact-case entry exists', () => {
    // Regression guard for the fail-closed refactor: the case-insensitive
    // bare-name fallback must survive the path-claim tightening.
    const reels = entry({
      name: 'reels',
      path: '/tmp/reels',
      storagePath: '/tmp/reels/.gitnexus',
    });

    expect(resolveRegisteredRepoEntry([reels], 'REELS')).toBe(reels);
  });
});
