/**
 * Integration Tests: Context Resource Staleness Fix (#2438)
 *
 * Verifies that `gitnexus://repo/{name}/context` reads fresh metadata from
 * disk on every call so the staleness banner and stats always reflect the
 * actual on-disk state after an out-of-process `analyze --index-only` refresh
 * — even when the LocalBackend's in-memory RepoHandle is stale.
 *
 * Reproduce sequence (from the issue):
 *   1. LocalBackend starts → reads registry → caches RepoHandle (lastCommit = C1)
 *   2. `analyze --index-only` runs out-of-process → writes gitnexus.json (lastCommit = C2)
 *   3. Re-read context resource → must NOT show stale banner, must show fresh stats
 *
 * This is an integration test that exercises real file I/O (git + gitnexus.json)
 * without requiring a full LadybugDB index. The registry is mocked so CI doesn't
 * require the native addon, but loadMeta reads real JSON files on disk.
 */
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';
import type { RegistryEntry } from '../../src/storage/repo-manager.js';
import type { RepoMeta } from '../../src/storage/repo-manager.js';

// Mock listRegisteredRepos to control which repos the backend sees.
// loadMeta, loadMetaLegacy, and saveMeta are left un-mocked so the test
// exercises real file I/O. cleanupOldKuzuFiles and findSiblingClones are
// stubbed to no-ops to keep the test clean.
const { listRegisteredReposMock } = vi.hoisted(() => ({
  listRegisteredReposMock: vi.fn<() => Promise<RegistryEntry[]>>().mockResolvedValue([]),
}));

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: listRegisteredReposMock,
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
  };
});

// Stub git-staleness so the test controls the staleness signal independently
// of whether git is available in the CI path. The real checkStaleness function
// would also work (it shells out to git which IS available), but mocking lets us
// assert the exact commits passed without relying on git rev-list output.
const { checkStalenessMock } = vi.hoisted(() => ({
  checkStalenessMock: vi.fn().mockReturnValue({ isStale: false, commitsBehind: 0 }),
}));

vi.mock('../../src/core/git-staleness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/git-staleness.js')>();
  return {
    ...actual,
    checkStaleness: checkStalenessMock,
    checkStalenessAsync: vi.fn().mockResolvedValue({ isStale: false, commitsBehind: 0 }),
    checkCwdMatch: vi.fn().mockResolvedValue({ match: 'none' }),
  };
});

vi.mock('../../src/mcp/staleness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/staleness.js')>();
  return { ...actual, checkStaleness: checkStalenessMock };
});

// Stub LadybugDB pool — we never open an actual DB in this test.
vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn().mockResolvedValue(undefined),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(false),
  };
});
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn().mockResolvedValue(undefined),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(false),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { readResource } from '../../src/mcp/resources.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Write a gitnexus.json (RepoMeta) to the given storagePath directory. */
function writeMetaJson(storagePath: string, meta: RepoMeta): void {
  mkdirSync(storagePath, { recursive: true });
  writeFileSync(path.join(storagePath, 'gitnexus.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

/** Build a minimal RegistryEntry for a tmp repo dir. */
function makeRegistryEntry(
  repoPath: string,
  storagePath: string,
  lastCommit: string,
  stats: NonNullable<RepoMeta['stats']>,
): RegistryEntry {
  return {
    name: 'test-repo',
    path: repoPath,
    storagePath,
    indexedAt: '2024-01-01T00:00:00Z',
    lastCommit,
    stats,
    branches: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('context resource freshness — out-of-process analyze (#2438)', () => {
  let tmpDir: Awaited<ReturnType<typeof createTempDir>>;
  let repoPath: string;
  let storagePath: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await createTempDir('gnx-ctx-staleness-');
    repoPath = tmpDir.dbPath;
    storagePath = path.join(repoPath, '.gitnexus');
    mkdirSync(storagePath, { recursive: true });

    // Isolate the global registry from the developer's real ~/.gitnexus
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = storagePath;

    checkStalenessMock.mockReset();
    checkStalenessMock.mockReturnValue({ isStale: false, commitsBehind: 0 });
    listRegisteredReposMock.mockReset();
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpDir.cleanup();
  });

  it('clears the staleness banner after out-of-process analyze updates gitnexus.json', async () => {
    // ── STEP 1: Initial analyze writes gitnexus.json with old commit (C1) ───
    const c1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // simulated HEAD at index time
    const c2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // new HEAD after more commits
    const oldStats = { files: 100, nodes: 500, processes: 10 };
    const freshStats = { files: 120, nodes: 600, processes: 12 };

    writeMetaJson(storagePath, {
      repoPath,
      lastCommit: c1,
      indexedAt: '2024-01-01T00:00:00Z',
      stats: oldStats,
    });

    // Registry entry also points to C1 (what LocalBackend reads at init time)
    listRegisteredReposMock.mockResolvedValue([
      makeRegistryEntry(repoPath, storagePath, c1, oldStats),
    ]);

    const backend = new LocalBackend();
    await backend.init();

    // ── STEP 2: Time passes; new commits land. checkStaleness now reports stale ──
    checkStalenessMock.mockReturnValue({
      isStale: true,
      commitsBehind: 5,
      hint: '⚠️ Index is 5 commits behind HEAD. Run analyze tool to update.',
    });

    const resultBefore = await readResource(`gitnexus://repo/test-repo/context`, backend);
    expect(resultBefore).toContain('staleness:');
    expect(resultBefore).toContain('5 commits behind');
    // Stats reflect the old (C1-era) values from gitnexus.json
    expect(resultBefore).toContain('files: 100');
    expect(resultBefore).toContain('symbols: 500');

    // ── STEP 3: Out-of-process analyze runs, updates gitnexus.json to C2 ───
    // The MCP server (LocalBackend) is NOT restarted — this is the bug scenario.
    writeMetaJson(storagePath, {
      repoPath,
      lastCommit: c2,
      indexedAt: new Date().toISOString(),
      stats: freshStats,
    });
    // checkStaleness is now called with C2 (which equals HEAD) — not stale
    checkStalenessMock.mockImplementation((_repoPath: string, commit: string) => {
      if (commit === c2) {
        return { isStale: false, commitsBehind: 0 };
      }
      // C1 is still stale (5 commits behind)
      return { isStale: true, commitsBehind: 5, hint: '⚠️ Index is 5 commits behind HEAD.' };
    });

    // ── STEP 4: Re-read context resource WITHOUT restarting the MCP server ──
    // The backend's cached RepoHandle still has lastCommit = C1 (never refreshed).
    // The fix must read from disk to get C2 and pass it to checkStaleness.
    const resultAfter = await readResource(`gitnexus://repo/test-repo/context`, backend);

    // Staleness banner MUST be gone — the fresh gitnexus.json has lastCommit = C2
    expect(resultAfter).not.toContain('staleness:');
    // Stats MUST be fresh — taken from the updated gitnexus.json
    expect(resultAfter).toContain('files: 120');
    expect(resultAfter).toContain('symbols: 600');
    expect(resultAfter).toContain('processes: 12');
  });

  it('shows stale banner before analyze and clears it after — full reproduce sequence', async () => {
    const c1 = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
    const c2 = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
    const stats = { files: 50, nodes: 200, processes: 5 };

    // Initial state: indexed at C1
    writeMetaJson(storagePath, {
      repoPath,
      lastCommit: c1,
      indexedAt: '2024-01-01T00:00:00Z',
      stats,
    });
    listRegisteredReposMock.mockResolvedValue([
      makeRegistryEntry(repoPath, storagePath, c1, stats),
    ]);

    const backend = new LocalBackend();
    await backend.init();

    // Pre-analyze: not stale (index is current)
    checkStalenessMock.mockReturnValue({ isStale: false, commitsBehind: 0 });
    const r1 = await readResource(`gitnexus://repo/test-repo/context`, backend);
    expect(r1).not.toContain('staleness:');

    // New commits arrive; C1 is now stale
    checkStalenessMock.mockReturnValue({
      isStale: true,
      commitsBehind: 31,
      hint: '⚠️ Index is 31 commits behind HEAD. Run analyze tool to update.',
    });
    const r2 = await readResource(`gitnexus://repo/test-repo/context`, backend);
    expect(r2).toContain('staleness:');
    expect(r2).toContain('31 commits behind');

    // Out-of-process analyze --index-only completes; gitnexus.json updated to C2
    const freshStats = { files: 60, nodes: 250, processes: 7 };
    writeMetaJson(storagePath, {
      repoPath,
      lastCommit: c2,
      indexedAt: new Date().toISOString(),
      stats: freshStats,
    });

    // When the fresh commit is passed to checkStaleness it's not stale anymore
    checkStalenessMock.mockImplementation((_: string, commit: string) =>
      commit === c2
        ? { isStale: false, commitsBehind: 0 }
        : { isStale: true, commitsBehind: 31, hint: '⚠️ Index is 31 commits behind HEAD.' },
    );

    // Third read — MCP server still running, but context must reflect fresh state
    const r3 = await readResource(`gitnexus://repo/test-repo/context`, backend);
    expect(r3).not.toContain('staleness:'); // banner cleared
    expect(r3).toContain('files: 60'); // fresh stats
    expect(r3).toContain('symbols: 250');
    expect(r3).toContain('processes: 7');
  });

  it('stat fields absent in disk meta fall through to cached context stats', async () => {
    // Some older gitnexus.json files omit the stats field. The fallback must
    // use the cached context stats rather than showing zeros or undefined.
    const c1 = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const oldStats = { files: 77, nodes: 333, processes: 4 };

    // Disk meta has NO stats (simulating an older or partially-written meta)
    writeMetaJson(storagePath, {
      repoPath,
      lastCommit: c1,
      indexedAt: '2024-01-01T00:00:00Z',
      // stats omitted intentionally
    });
    listRegisteredReposMock.mockResolvedValue([
      makeRegistryEntry(repoPath, storagePath, c1, oldStats),
    ]);

    const backend = new LocalBackend();
    await backend.init();

    const result = await readResource(`gitnexus://repo/test-repo/context`, backend);
    // Falls back to cached context stats (from registry entry)
    expect(result).toContain('files: 77');
    expect(result).toContain('symbols: 333');
    expect(result).toContain('processes: 4');
  });
});
