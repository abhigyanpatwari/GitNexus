import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import type { GroupConfig, GroupManifestLink } from '../../../src/core/group/types.js';

// Two test surfaces for the windowed manifest resolution (issue #2189 / PR #2191
// review, Finding 3 — bound peak pool residency to MAX_POOL_SIZE regardless of
// group size):
//
//   1. partitionManifestWindows — a pure function; the bounded-residency logic
//      lives here (every window references <= maxResident repos, every link in
//      exactly one window). Tested directly, no pool.
//   2. A real-pool integration test that drives syncGroup through the actual
//      pool (native LadybugDB layer mocked, as in lbug-pool-pinning.test.ts) and
//      asserts the count of concurrently-open Databases never exceeds the
//      resident cap — the end-to-end residency bound the review flagged as
//      missing.

// ── Surface 1: pure partition function ──────────────────────────────────────

describe('partitionManifestWindows (issue #2189 windowed resolution)', () => {
  const link = (from: string, to: string): GroupManifestLink => ({
    from,
    to,
    type: 'http',
    contract: `GET::/${from}-${to}`,
    role: 'consumer',
  });

  it('keeps every window within maxResident repos and places every link exactly once', async () => {
    const { partitionManifestWindows } = await import('../../../src/core/group/sync.js');
    const repos = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
    const known = new Set(repos);
    // A star: every leaf links to the hub r1, plus a few leaf-leaf links.
    const links = [
      link('r1', 'r2'),
      link('r1', 'r3'),
      link('r1', 'r4'),
      link('r1', 'r5'),
      link('r1', 'r6'),
      link('r7', 'r8'),
      link('r2', 'r3'),
    ];
    const maxResident = 5;
    const windows = partitionManifestWindows(links, known, maxResident);

    // Bounded residency: no window references more than maxResident repos.
    for (const w of windows) expect(w.repos.size).toBeLessThanOrEqual(maxResident);

    // True partition: every link appears in exactly one window.
    const placed = windows.flatMap((w) => w.links);
    expect(placed).toHaveLength(links.length);
    const placedKeys = placed.map((l) => `${l.from}->${l.to}`).sort();
    const inputKeys = links.map((l) => `${l.from}->${l.to}`).sort();
    expect(placedKeys).toEqual(inputKeys);
    // No link appears twice (the contract-dedup invariant — KTD-4).
    expect(new Set(placedKeys).size).toBe(placedKeys.length);
  });

  it('counts only in-group repos toward a window; dangling links consume no budget', async () => {
    const { partitionManifestWindows } = await import('../../../src/core/group/sync.js');
    const known = new Set(['r1']);
    const links = [
      link('r1', 'external-a'), // 1 in-group repo
      link('external-b', 'external-c'), // 0 in-group repos (fully dangling)
    ];
    const windows = partitionManifestWindows(links, known, 5);
    // Both links are still placed (so they yield synthetic-UID contracts)...
    expect(windows.flatMap((w) => w.links)).toHaveLength(2);
    // ...but the only repo counted is r1.
    const allRepos = new Set(windows.flatMap((w) => [...w.repos]));
    expect(allRepos).toEqual(new Set(['r1']));
  });

  it('returns no windows for an empty link set', async () => {
    const { partitionManifestWindows } = await import('../../../src/core/group/sync.js');
    expect(partitionManifestWindows([], new Set(['r1']), 5)).toEqual([]);
  });

  it('splits links across multiple windows when referenced repos exceed maxResident', async () => {
    const { partitionManifestWindows } = await import('../../../src/core/group/sync.js');
    const known = new Set(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    // 3 disjoint repo-pairs = 6 distinct repos; maxResident 2 forces ≥3 windows.
    const links = [link('r1', 'r2'), link('r3', 'r4'), link('r5', 'r6')];
    const windows = partitionManifestWindows(links, known, 2);
    expect(windows.length).toBeGreaterThanOrEqual(3);
    for (const w of windows) expect(w.repos.size).toBeLessThanOrEqual(2);
    expect(windows.flatMap((w) => w.links)).toHaveLength(3);
  });
});

// ── Surface 2: real-pool residency bound through syncGroup ───────────────────

const { loadFTSExtensionMock, openCounter } = vi.hoisted(() => ({
  loadFTSExtensionMock: vi.fn(),
  openCounter: { live: 0, peak: 0 },
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(function (this: any) {
      this.query = vi.fn().mockResolvedValue({
        getAll: vi.fn().mockResolvedValue([]),
        close: vi.fn(),
      });
      // executeParameterized's prepare/execute path (manifest resolveSymbol).
      this.prepare = vi.fn().mockResolvedValue({
        isSuccess: () => true,
        getErrorMessage: vi.fn().mockResolvedValue(''),
      });
      this.execute = vi.fn().mockResolvedValue({
        getAll: vi.fn().mockResolvedValue([]),
        close: vi.fn(),
      });
      this.close = vi.fn().mockResolvedValue(undefined);
    }),
  },
}));

vi.mock('../../../src/core/lbug/lbug-adapter.js', () => ({
  isReadOnlyDbError: vi.fn(() => false),
  loadFTSExtension: loadFTSExtensionMock,
}));

vi.mock('../../../src/core/lbug/lbug-config.js', () => ({
  // Track concurrently-open Databases: a fresh fake per open, decrement on close.
  createLbugDatabase: vi.fn(() => {
    openCounter.live += 1;
    openCounter.peak = Math.max(openCounter.peak, openCounter.live);
    return {
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockImplementation(async () => {
        openCounter.live -= 1;
      }),
    };
  }),
  toNativeSafePath: vi.fn((p: string) => p),
  isWalCorruptionError: vi.fn(() => false),
  WAL_RECOVERY_SUGGESTION: '',
}));

vi.mock('../../../src/core/lbug/sidecar-recovery.js', () => ({
  preflightLbugSidecars: vi.fn().mockResolvedValue(undefined),
  isMissingFsError: vi.fn(() => false),
  isMissingShadowSidecarError: vi.fn(() => false),
  isReadOnlyShadowReplayError: vi.fn(() => false),
  quarantineWalForMissingShadow: vi.fn().mockResolvedValue(''),
  renameFailureMessage: vi.fn((p: string) => `rename failed for ${p}`),
  statIfExists: vi.fn().mockResolvedValue(null),
}));

// readRegistry is called in syncGroup's else branch; resolveRepoHandle is
// supplied, so an empty registry is fine (only the meta.json fallback reads it).
vi.mock('../../../src/storage/repo-manager.js', () => ({
  readRegistry: vi.fn().mockResolvedValue([]),
}));

const { syncGroup } = await import('../../../src/core/group/sync.js');
const { closeLbug, getMaxResidentRepos } = await import('../../../src/core/lbug/pool-adapter.js');

describe('syncGroup windowed resolution bounds pool residency (real pool, #2189)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'gn-window-resid-'));
    loadFTSExtensionMock.mockResolvedValue(true);
    openCounter.live = 0;
    openCounter.peak = 0;
  });

  afterEach(async () => {
    await closeLbug().catch(() => {});
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('never holds more than getMaxResidentRepos() Databases open for a large group', async () => {
    const maxResident = getMaxResidentRepos();
    const repoCount = maxResident + 4; // exceed the cap so windowing must split

    const repos: Record<string, string> = {};
    const links: GroupManifestLink[] = [];
    for (let i = 1; i <= repoCount; i++) {
      const gp = `app/repo-${i}`;
      repos[gp] = `repo-${i}`;
      // Star topology: every repo links to repo-1 → many windows reference repo-1.
      if (i > 1) {
        links.push({
          from: gp,
          to: 'app/repo-1',
          type: 'http',
          contract: `GET::/api/${i}`,
          role: 'consumer',
        });
      }
    }

    const config: GroupConfig = {
      version: 1,
      name: 'test',
      description: '',
      repos,
      links,
      packages: {},
      // All detection off → init loop just opens pools (no extractor file reads).
      detect: {
        http: false,
        grpc: false,
        thrift: false,
        topics: false,
        shared_libs: false,
        embedding_fallback: false,
        workspace_deps: false,
      },
      matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
    };

    await syncGroup(config, {
      resolveRepoHandle: async (_name, groupPath) => {
        // Each repo gets a real storage dir with a fake lbug file so fs.stat in
        // doInitLbug succeeds; distinct paths → distinct Databases.
        const storagePath = path.join(tmpRoot, groupPath);
        mkdirSync(storagePath, { recursive: true });
        writeFileSync(path.join(storagePath, 'lbug'), '');
        return {
          id: groupPath.replace(/\//g, '-'),
          path: groupPath,
          repoPath: storagePath,
          storagePath,
        };
      },
      skipWrite: true,
    });

    // The init loop (no pin) keeps the pool at the LRU cap; windowed resolution
    // leases <= maxResident repos per window and releases them. Peak concurrent
    // open Databases must stay within the resident cap (+ at most one transient
    // overshoot at an init boundary — the pool's documented soft cap).
    expect(openCounter.peak).toBeGreaterThan(0);
    expect(openCounter.peak).toBeLessThanOrEqual(maxResident + 1);
  });
});
