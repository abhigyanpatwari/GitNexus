import { describe, expect, it } from 'vitest';
import { resolveRegisteredRepoEntry } from '../../src/server/api.js';
import type { RegistryEntry } from '../../src/storage/repo-manager.js';

const entry = (overrides: Partial<RegistryEntry>): RegistryEntry => ({
  name: 'repo',
  path: '/tmp/repo',
  storagePath: '/tmp/repo/.gitnexus',
  indexedAt: '2026-07-09T00:00:00.000Z',
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
});
