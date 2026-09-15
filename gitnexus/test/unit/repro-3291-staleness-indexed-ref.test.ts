/**
 * #3291: the tool staleness payload names the ref it describes, so an `impact`
 * answer computed from a branch-pinned index is distinguishable from one
 * computed from a current index of the default branch.
 *
 * Unlike the rest of the staleness suite, this file deliberately does NOT mock
 * `core/git-staleness.js`. Real `git rev-list` runs against two real clones —
 * that is the whole point: the behaviour is a composition of the real
 * measurement (`<lastCommit>..HEAD`, against the clone's own checkout) with
 * what `stalenessPayload` does about it, and stubbing the measurement would
 * assume the step under test.
 *
 * Before the fix both responses carried no `staleness` field at all and were
 * byte-identical; the serialized-inequality assertion below is the one that
 * could not discriminate them.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    ensureVectorExtension: vi.fn().mockResolvedValue(true),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...lbugMocks,
}));
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...lbugMocks,
}));

// `readRegistry` is pinned to empty so the real `checkCwdMatch` (reached through
// the un-mocked git-staleness module) cannot read the developer's own registry.
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  readRegistry: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue({ results: [], ftsAvailable: true }),
}));
vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();

const commit = (repo: string, file: string, body: string): void => {
  writeFileSync(path.join(repo, file), body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', `add ${file}`);
};

const fixtureRoots: string[] = [];

/**
 * A source repo with `main` three commits deep and `feature/x` branched off the
 * first, then two clones of it: one on `main`, one pinned to `feature/x` — the
 * separate-clone-per-pinned-branch layout #3199 made routine.
 */
function makeClones(): { mainClone: string; branchClone: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gnx-3291-'));
  fixtureRoots.push(root);

  const source = path.join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.email', 'repro@3291.test');
  git(source, 'config', 'user.name', 'Repro 3291');

  commit(source, 'a.ts', 'export const a = 1;\n');
  git(source, 'checkout', '-b', 'feature/x');
  commit(source, 'feature.ts', 'export const f = 1;\n');
  git(source, 'checkout', 'main');
  commit(source, 'b.ts', 'export const b = 2;\n');
  commit(source, 'c.ts', 'export const c = 3;\n');

  const mainClone = path.join(root, 'clone-main');
  const branchClone = path.join(root, 'clone-feature');
  git(root, 'clone', '--branch', 'main', source, mainClone);
  git(root, 'clone', '--branch', 'feature/x', source, branchClone);

  return { mainClone, branchClone };
}

interface ToolStaleness {
  status: string;
  branch?: string;
  lastCommit?: string;
  indexedAt?: string;
  measuredAgainst?: string;
  commitsBehind?: number;
  hint?: string;
}

const INDEXED_AT = '2026-09-15T00:00:00Z';
const IMPACT_RESULT = { target: 'doWork', impactedCount: 0, risk: 'LOW' };

const handleFor = (repoPath: string, lastCommit: string, branch: string) => ({
  id: branch,
  name: 'repro-3291',
  repoPath,
  storagePath: path.join(repoPath, '.gitnexus'),
  lbugPath: path.join(repoPath, '.gitnexus', branch, 'lbug'),
  indexedAt: INDEXED_AT,
  lastCommit,
  branch,
});

afterAll(() => {
  for (const dir of fixtureRoots) rmSync(dir, { recursive: true, force: true });
});

describe('#3291 — tool staleness names the indexed ref', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    await backend.init();
  });

  it('distinguishes a behind-main feature-branch index from a current main index', async () => {
    const { mainClone, branchClone } = makeClones();
    const mainHead = git(mainClone, 'rev-parse', 'HEAD');
    const branchHead = git(branchClone, 'rev-parse', 'HEAD');

    // Precondition, measured rather than assumed: the feature-branch clone is
    // freshly analyzed at its own head, and that head is genuinely two commits
    // short of the mainline. Without this the test would pass vacuously.
    const behindMain = Number(
      git(branchClone, 'rev-list', '--count', `${branchHead}..origin/main`),
    );
    expect(behindMain).toBe(2);

    const resolve = vi.spyOn(backend, 'selectToolRepository');
    resolve.mockResolvedValueOnce(handleFor(mainClone, mainHead, 'main') as never);
    resolve.mockResolvedValueOnce(handleFor(branchClone, branchHead, 'feature/x') as never);

    // The graph answer itself is held constant so the only thing that can differ
    // between the two responses is the freshness signalling under test.
    vi.spyOn(backend as unknown as { impact: unknown }, 'impact').mockResolvedValue(
      IMPACT_RESULT as never,
    );

    const fromMain = (await backend.callTool('impact', {
      target: 'doWork',
      repo: 'repro-3291',
    })) as { staleness: ToolStaleness };
    const fromBranch = (await backend.callTool('impact', {
      target: 'doWork',
      repo: 'repro-3291',
      branch: 'feature/x',
    })) as { staleness: ToolStaleness };

    // Non-vacuity: both calls really produced the graph answer. An error
    // envelope or a non-object would be skipped by `canCarryStaleness` and the
    // assertions below would hold for the wrong reason.
    expect(fromMain).toMatchObject(IMPACT_RESULT);
    expect(fromBranch).toMatchObject(IMPACT_RESULT);

    // Each index measures 0 commits behind its OWN checkout, so both are
    // `current` — but each now says which ref that statement is about.
    expect(fromBranch.staleness).toEqual({
      status: 'current',
      branch: 'feature/x',
      lastCommit: branchHead,
      indexedAt: INDEXED_AT,
      measuredAgainst: 'HEAD',
    });
    expect(fromMain.staleness).toMatchObject({
      status: 'current',
      branch: 'main',
      lastCommit: mainHead,
    });

    // The regression itself: before the fix these two were byte-identical, so an
    // answer two commits short of the mainline read exactly like a current one.
    expect(JSON.stringify(fromBranch)).not.toBe(JSON.stringify(fromMain));

    // And the ref is recoverable from the response alone, with no second call.
    const serialized = JSON.stringify(fromBranch);
    expect(serialized).toContain('feature/x');
    expect(serialized).toContain(branchHead);
  });

  // Negative control. The same wiring — real git, real `checkStalenessAsync`,
  // real `attachToolStaleness` — must still report a counted gap when the index
  // is behind its own checkout. Without this, the ref-carrying payload above
  // could be masking a freshness signal that no longer works.
  it('still reports the counted gap when the index is behind its own checkout', async () => {
    const { mainClone } = makeClones();
    const twoBack = git(mainClone, 'rev-parse', 'HEAD~2');

    vi.spyOn(backend, 'selectToolRepository').mockResolvedValue(
      handleFor(mainClone, twoBack, 'main') as never,
    );
    vi.spyOn(backend as unknown as { impact: unknown }, 'impact').mockResolvedValue(
      IMPACT_RESULT as never,
    );

    const result = (await backend.callTool('impact', {
      target: 'doWork',
      repo: 'repro-3291',
    })) as { staleness: ToolStaleness };

    expect(result.staleness).toMatchObject({
      status: 'behind',
      commitsBehind: 2,
      branch: 'main',
      lastCommit: twoBack,
      measuredAgainst: 'HEAD',
    });
  });

  // A detached HEAD or a legacy index records no branch label, so the ref has to
  // survive without one — `lastCommit` is the identifier that is always present.
  it('names the ref by commit when the index records no branch label', async () => {
    const { mainClone } = makeClones();
    const head = git(mainClone, 'rev-parse', 'HEAD');
    const { branch: _unlabelled, ...unlabelledHandle } = handleFor(mainClone, head, 'main');

    vi.spyOn(backend, 'selectToolRepository').mockResolvedValue(unlabelledHandle as never);
    vi.spyOn(backend as unknown as { impact: unknown }, 'impact').mockResolvedValue(
      IMPACT_RESULT as never,
    );

    const result = (await backend.callTool('impact', {
      target: 'doWork',
      repo: 'repro-3291',
    })) as { staleness: ToolStaleness };

    expect(result.staleness).toEqual({
      status: 'current',
      lastCommit: head,
      indexedAt: INDEXED_AT,
      measuredAgainst: 'HEAD',
    });
  });
});
