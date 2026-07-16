/**
 * Integration Tests: Context Resource Staleness Fix (#2438)
 *
 * End-to-end flow with real git and real registry/meta I/O.
 */
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import { getStoragePaths, registerRepo, saveMeta } from '../../src/storage/repo-manager.js';

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { readResource } from '../../src/mcp/resources.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function runGit(repoPath: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed in ${repoPath}: ${message}`);
  }
}

/**
 * Persist index metadata and register the repo in the global registry.
 * `saveMeta` runs before `registerRepo` so registry validation can immediately
 * see a readable metadata file for this entry.
 * @param repoPath Absolute path to the git repository under test.
 * @param storagePath Absolute path to the repo metadata directory.
 * @param meta Metadata snapshot to write to gitnexus.json and registry.
 * @param repoName Registry alias used by LocalBackend for this repo.
 */
async function seedIndexedRepo(
  repoPath: string,
  storagePath: string,
  meta: RepoMeta,
  repoName: string = 'test-repo',
): Promise<void> {
  await saveMeta(storagePath, meta);
  await registerRepo(repoPath, meta, { name: repoName });
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

    // Isolate the global registry from the developer's real ~/.gitnexus
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = path.join(repoPath, '.gitnexus-home');
    storagePath = getStoragePaths(repoPath).storagePath;

    runGit(repoPath, 'init');
    runGit(repoPath, 'config', 'user.name', 'GitNexus Test');
    runGit(repoPath, 'config', 'user.email', 'gitnexus@example.com');
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpDir.cleanup();
  });

  it('clears the staleness banner after out-of-process analyze updates gitnexus.json', async () => {
    // ── STEP 1: Repository HEAD advances from C1 to C2 ───────────────────────
    writeFileSync(path.join(repoPath, 'a.ts'), 'export const a = 1;\n');
    runGit(repoPath, 'add', 'a.ts');
    runGit(repoPath, 'commit', '-m', 'c1');
    const c1 = runGit(repoPath, 'rev-parse', 'HEAD');
    writeFileSync(path.join(repoPath, 'b.ts'), 'export const b = 2;\n');
    runGit(repoPath, 'add', 'b.ts');
    runGit(repoPath, 'commit', '-m', 'c2');
    const c2 = runGit(repoPath, 'rev-parse', 'HEAD');

    const oldStats = { files: 100, nodes: 500, processes: 10 };
    const freshStats = { files: 120, nodes: 600, processes: 12 };

    await seedIndexedRepo(repoPath, storagePath, {
      repoPath,
      lastCommit: c1,
      indexedAt: '2024-01-01T00:00:00Z',
      stats: oldStats,
    });

    const backend = new LocalBackend();
    await backend.init();

    // C1 is stale against current HEAD (C2)
    const resultBefore = await readResource(`gitnexus://repo/test-repo/context`, backend);
    expect(resultBefore).toContain('staleness:');
    expect(resultBefore).toContain('1 commit behind');
    // Stats reflect the old (C1-era) values from gitnexus.json
    expect(resultBefore).toContain('files: 100');
    expect(resultBefore).toContain('symbols: 500');

    // ── STEP 3: Out-of-process analyze runs, updates gitnexus.json to C2 ───
    // The MCP server (LocalBackend) is NOT restarted — this is the bug scenario.
    await saveMeta(storagePath, {
      repoPath,
      lastCommit: c2,
      indexedAt: new Date().toISOString(),
      stats: freshStats,
    });

    // ── STEP 4: Re-read context resource WITHOUT restarting the MCP server ──
    const resultAfter = await readResource(`gitnexus://repo/test-repo/context`, backend);

    // Staleness banner MUST be gone — the fresh gitnexus.json has lastCommit = C2
    expect(resultAfter).not.toContain('staleness:');
    // Stats MUST be fresh — taken from the updated gitnexus.json
    expect(resultAfter).toContain('files: 120');
    expect(resultAfter).toContain('symbols: 600');
    expect(resultAfter).toContain('processes: 12');
  });

  it('shows stale banner before analyze and clears it after — full reproduce sequence', async () => {
    writeFileSync(path.join(repoPath, 'a.ts'), 'export const a = 1;\n');
    runGit(repoPath, 'add', 'a.ts');
    runGit(repoPath, 'commit', '-m', 'c1');
    writeFileSync(path.join(repoPath, 'b.ts'), 'export const b = 2;\n');
    runGit(repoPath, 'add', 'b.ts');
    runGit(repoPath, 'commit', '-m', 'c2');
    const c2 = runGit(repoPath, 'rev-parse', 'HEAD');

    const stats = { files: 50, nodes: 200, processes: 5 };
    await seedIndexedRepo(repoPath, storagePath, {
      repoPath,
      lastCommit: c2,
      indexedAt: '2024-01-01T00:00:00Z',
      stats,
    });

    const backend = new LocalBackend();
    await backend.init();

    // Pre-analyze: registry/meta are seeded at current HEAD (C2), so not stale
    const r1 = await readResource(`gitnexus://repo/test-repo/context`, backend);
    expect(r1).not.toContain('staleness:');

    // New commit arrives; indexed commit (C2) is stale
    writeFileSync(path.join(repoPath, 'c.ts'), 'export const c = 3;\n');
    runGit(repoPath, 'add', 'c.ts');
    runGit(repoPath, 'commit', '-m', 'c3');
    const c3 = runGit(repoPath, 'rev-parse', 'HEAD');
    const r2 = await readResource(`gitnexus://repo/test-repo/context`, backend);
    expect(r2).toContain('staleness:');
    expect(r2).toContain('1 commit behind');

    // Out-of-process analyze --index-only completes; gitnexus.json updated to C3
    const freshStats = { files: 60, nodes: 250, processes: 7 };
    await saveMeta(storagePath, {
      repoPath,
      lastCommit: c3,
      indexedAt: new Date().toISOString(),
      stats: freshStats,
    });

    // Third read — MCP server still running, but context must reflect fresh state
    const r3 = await readResource(`gitnexus://repo/test-repo/context`, backend);
    expect(r3).not.toContain('staleness:'); // banner cleared
    expect(r3).toContain('files: 60'); // fresh stats
    expect(r3).toContain('symbols: 250');
    expect(r3).toContain('processes: 7');
  });

  it('stat fields absent in disk meta fall through to cached context stats', async () => {
    writeFileSync(path.join(repoPath, 'a.ts'), 'export const a = 1;\n');
    runGit(repoPath, 'add', 'a.ts');
    runGit(repoPath, 'commit', '-m', 'c1');
    const c1 = runGit(repoPath, 'rev-parse', 'HEAD');

    const oldStats = { files: 77, nodes: 333, processes: 4 };
    await seedIndexedRepo(repoPath, storagePath, {
      repoPath,
      lastCommit: c1,
      indexedAt: '2024-01-01T00:00:00Z',
      stats: oldStats,
    });

    const backend = new LocalBackend();
    await backend.init();

    // Overwrite disk meta with NO stats (simulating an older/partial file)
    await saveMeta(storagePath, {
      repoPath,
      lastCommit: c1,
      indexedAt: new Date().toISOString(),
    });

    const result = await readResource(`gitnexus://repo/test-repo/context`, backend);
    // Falls back to cached context stats (from registry entry)
    expect(result).toContain('files: 77');
    expect(result).toContain('symbols: 333');
    expect(result).toContain('processes: 4');
  });
});
