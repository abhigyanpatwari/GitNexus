/**
 * Unit Tests: CrossRepoRegistry — reverseDepMap & findConsumers
 *
 * Tests the reverse dependency map construction and consumer lookup:
 * T-CR-01: Single consumer depends on single provider
 * T-CR-02: Multiple consumers of same provider
 * T-CR-03: Circular dependencies
 * T-CR-04: Manifest with no dependencies
 * T-CR-05: Unknown repoId returns empty array
 * T-CR-06: Idempotent initialization
 * T-CR-07: Dependency not in any registered repo
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrossRepoRegistry } from '../../src/core/ingestion/cross-repo-registry.js';
import type { RepoManifest } from '../../src/storage/repo-manifest.js';

// ─── Mock readManifest ────────────────────────────────────────────────
// vi.hoisted ensures the mock fn is available when the hoisted vi.mock factory runs
const { readManifestMock } = vi.hoisted(() => ({
  readManifestMock: vi.fn<(path: string) => Promise<RepoManifest | null>>(),
}));

vi.mock('../../src/storage/repo-manifest.js', () => ({
  readManifest: (...args: [string]) => readManifestMock(...args),
  MANIFEST_FILE: 'gitnexus-manifest.json',
  createEmptyManifest: vi.fn(),
  writeManifest: vi.fn(),
}));

/** Helper: create a RepoManifest */
function manifest(repoId: string, dependencies: string[]): RepoManifest {
  return { repoId, indexedAt: '2026-05-01T00:00:00Z', dependencies };
}

describe('CrossRepoRegistry — reverseDepMap & findConsumers', () => {
  let registry: CrossRepoRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new CrossRepoRegistry();
  });

  // ─── T-CR-01: Single consumer → single provider ────────────────────
  it('T-CR-01: single consumer depends on single provider', async () => {
    readManifestMock.mockImplementation(async (path: string) => {
      if (path === '/repos/tcbs-bond-trading') {
        return manifest('tcbs-bond-trading', [
          'com.tcbs.bond.trading:tcbs-bond-trading-core',
        ]);
      }
      if (path === '/repos/tcbs-bond-trading-core') {
        return manifest('tcbs-bond-trading-core', []);
      }
      return null;
    });

    await registry.initialize([
      { repoId: 'tcbs-bond-trading', repoPath: '/repos/tcbs-bond-trading' },
      { repoId: 'tcbs-bond-trading-core', repoPath: '/repos/tcbs-bond-trading-core' },
    ]);

    // The dependency "com.tcbs.bond.trading:tcbs-bond-trading-core" has
    // artifactId matching repo "tcbs-bond-trading-core", so findDepRepo resolves
    // to "tcbs-bond-trading-core" → consumer "tcbs-bond-trading" depends on it
    const consumers = registry.findConsumers('tcbs-bond-trading-core');
    expect(consumers).toEqual(['tcbs-bond-trading']);
  });

  // ─── T-CR-02: Multiple consumers of same provider ──────────────────
  it('T-CR-02: multiple consumers of same provider', async () => {
    readManifestMock.mockImplementation(async (path: string) => {
      if (path.includes('consumer-a')) {
        return manifest('consumer-a', ['com.example:shared-lib']);
      }
      if (path.includes('consumer-b')) {
        return manifest('consumer-b', ['com.example:shared-lib']);
      }
      if (path.includes('shared-lib')) {
        return manifest('shared-lib', []);
      }
      return null;
    });

    await registry.initialize([
      { repoId: 'consumer-a', repoPath: '/repos/consumer-a' },
      { repoId: 'consumer-b', repoPath: '/repos/consumer-b' },
      { repoId: 'shared-lib', repoPath: '/repos/shared-lib' },
    ]);

    const consumers = registry.findConsumers('shared-lib');
    expect(consumers.sort()).toEqual(['consumer-a', 'consumer-b']);
  });

  // ─── T-CR-03: Circular dependencies ─────────────────────────────────
  it('T-CR-03: circular dependencies', async () => {
    readManifestMock.mockImplementation(async (path: string) => {
      if (path.includes('repo-a')) {
        return manifest('repo-a', ['com.example:repo-b']);
      }
      if (path.includes('repo-b')) {
        return manifest('repo-b', ['com.example:repo-a']);
      }
      return null;
    });

    await registry.initialize([
      { repoId: 'repo-a', repoPath: '/repos/repo-a' },
      { repoId: 'repo-b', repoPath: '/repos/repo-b' },
    ]);

    // Both have artifactId matching the other's repoId
    const consumersA = registry.findConsumers('repo-a');
    expect(consumersA).toEqual(['repo-b']);
    const consumersB = registry.findConsumers('repo-b');
    expect(consumersB).toEqual(['repo-a']);
  });

  // ─── T-CR-04: Manifest with no dependencies ────────────────────────
  it('T-CR-04: manifest with no dependencies is excluded from reverse map', async () => {
    readManifestMock.mockImplementation(async (path: string) => {
      if (path.includes('standalone')) {
        return manifest('standalone', []);
      }
      if (path.includes('other')) {
        return manifest('other', ['com.example:standalone']);
      }
      return null;
    });

    await registry.initialize([
      { repoId: 'standalone', repoPath: '/repos/standalone' },
      { repoId: 'other', repoPath: '/repos/other' },
    ]);

    // "standalone" has no dependencies, so it won't appear as a consumer of anyone
    // But "other" depends on it (artifactId "standalone" matches repoId), so
    // standalone IS a provider with "other" as consumer
    const consumersOfStandalone = registry.findConsumers('standalone');
    expect(consumersOfStandalone).toEqual(['other']);

    // "other" has dependency so it could be a provider too, but nothing depends on it
    const consumersOfOther = registry.findConsumers('other');
    expect(consumersOfOther).toEqual([]);
  });



  // ─── T-CR-05: Unknown repoId ───────────────────────────────────────
  it('T-CR-05: unknown repoId returns empty array', async () => {
    readManifestMock.mockResolvedValue(null);

    await registry.initialize([
      { repoId: 'some-repo', repoPath: '/repos/some-repo' },
    ]);

    expect(registry.findConsumers('nonexistent')).toEqual([]);
  });

  // ─── T-CR-06: Idempotent initialization ────────────────────────────
  it('T-CR-06: calling initialize twice produces same reverseDepMap', async () => {
    readManifestMock.mockImplementation(async (path: string) => {
      if (path.includes('consumer')) {
        return manifest('consumer', ['com.example:provider']);
      }
      if (path.includes('provider')) {
        return manifest('provider', []);
      }
      return null;
    });

    await registry.initialize([
      { repoId: 'consumer', repoPath: '/repos/consumer' },
      { repoId: 'provider', repoPath: '/repos/provider' },
    ]);

    const first = registry.findConsumers('provider');

    // Second call is a no-op because this.loaded = true
    await registry.initialize([
      { repoId: 'consumer', repoPath: '/repos/consumer' },
      { repoId: 'provider', repoPath: '/repos/provider' },
    ]);

    const second = registry.findConsumers('provider');
    expect(first).toEqual(second);
  });

  // ─── T-CR-07: Dependency not in any registered repo ────────────────
  it('T-CR-07: dependency not in any registered repo is skipped', async () => {
    readManifestMock.mockImplementation(async (path: string) => {
      if (path.includes('consumer')) {
        return manifest('consumer', [
          'com.unknown:orphan-lib',
          'com.example:provider',
        ]);
      }
      if (path.includes('provider')) {
        return manifest('provider', []);
      }
      return null;
    });

    await registry.initialize([
      { repoId: 'consumer', repoPath: '/repos/consumer' },
      { repoId: 'provider', repoPath: '/repos/provider' },
    ]);

    // "orphan-lib" is not a registered repo → findDepRepo returns null for it
    // so no entry for a nonexistent provider; but provider still gets consumer
    const consumersOfProvider = registry.findConsumers('provider');
    expect(consumersOfProvider).toEqual(['consumer']);

    // No one registered "orphan-lib" as a repo, so no consumers for it
    expect(registry.findConsumers('orphan-lib')).toEqual([]);
  });

  // ─── T-CR-08: artifactId differs from repo name by a prefix (#46) ───
  it('T-CR-08: artifactId resolves to its prefixed provider repo, lists all consumers, no self-ref', async () => {
    // Maven artifactId "exception-handler" ≠ repo name "bond-exception-handler".
    // Two distinct consumers declare the same dependency.
    readManifestMock.mockImplementation(async (path: string) => {
      if (path.includes('bond-trading')) {
        return manifest('tcbs-bond-trading', ['com.tcbs.bond.trading:exception-handler']);
      }
      if (path.includes('bond-amqp')) {
        return manifest('tcbs-bond-amqp', ['com.tcbs.bond.trading:exception-handler']);
      }
      if (path.includes('exception-handler')) {
        return manifest('bond-exception-handler', []);
      }
      return null;
    });

    await registry.initialize([
      { repoId: 'tcbs-bond-trading', repoPath: '/repos/tcbs-bond-trading' },
      { repoId: 'tcbs-bond-amqp', repoPath: '/repos/tcbs-bond-amqp' },
      { repoId: 'bond-exception-handler', repoPath: '/repos/bond-exception-handler' },
    ]);

    // Provider correctness: artifactId "exception-handler" binds to the prefixed
    // repo "bond-exception-handler" (before #46 this returned [] — wrong provider).
    expect(registry.findConsumers('bond-exception-handler').sort()).toEqual([
      'tcbs-bond-amqp', 'tcbs-bond-trading',
    ]);

    // No repo is ever a cross-repo consumer of itself.
    expect(registry.findConsumers('tcbs-bond-trading')).not.toContain('tcbs-bond-trading');
    expect(registry.findConsumers('tcbs-bond-amqp')).not.toContain('tcbs-bond-amqp');
  });

  // ─── T-CR-09: ambiguous prefix match does not bind (#46) ────────────
  it('T-CR-09: an ambiguous artifactId suffix match does not remap (stays unresolved)', async () => {
    // Two repos both end with "-handler"; artifactId "handler" is ambiguous →
    // resolveArtifactToRepo returns null (require uniqueness) rather than guessing.
    readManifestMock.mockImplementation(async (path: string) => {
      if (path.includes('consumer')) {
        return manifest('consumer', ['com.example:handler']);
      }
      if (path.includes('a-handler')) {
        return manifest('a-handler', []);
      }
      if (path.includes('b-handler')) {
        return manifest('b-handler', []);
      }
      return null;
    });

    await registry.initialize([
      { repoId: 'consumer', repoPath: '/repos/consumer' },
      { repoId: 'a-handler', repoPath: '/repos/a-handler' },
      { repoId: 'b-handler', repoPath: '/repos/b-handler' },
    ]);

    // Ambiguous → neither provider claims the consumer (no wrong guess).
    expect(registry.findConsumers('a-handler')).toEqual([]);
    expect(registry.findConsumers('b-handler')).toEqual([]);
  });
});