import { beforeEach, describe, expect, it, vi } from 'vitest';

// #3524: LocalBackend's refresh_index around a stubbed analyze worker. The real
// worker, registry, and git are covered by test/integration/mcp-refresh-index-e2e.

const mocks = vi.hoisted(() => ({
  listRegisteredRepos: vi.fn(),
  runAutoSyncAnalysis: vi.fn(),
  checkStalenessAsync: vi.fn(),
  embeddingsFromGitnexusRc: vi.fn(),
}));

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return { ...actual, listRegisteredRepos: mocks.listRegisteredRepos };
});
vi.mock('../../src/core/auto-sync/analysis-worker-launch.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/auto-sync/analysis-worker-launch.js')>();
  return { ...actual, runAutoSyncAnalysis: mocks.runAutoSyncAnalysis };
});
vi.mock('../../src/core/git-staleness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/git-staleness.js')>();
  return { ...actual, checkStalenessAsync: mocks.checkStalenessAsync };
});
vi.mock('../../src/core/gitnexus-rc-embeddings.js', () => ({
  embeddingsFromGitnexusRc: mocks.embeddingsFromGitnexusRc,
}));

import path from 'node:path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const REPO = path.resolve('/work/shop');

function entry(overrides: Record<string, unknown> = {}) {
  return {
    name: 'shop',
    path: REPO,
    storagePath: `${REPO}/.gitnexus`,
    indexedAt: '2026-10-01T00:00:00.000Z',
    lastCommit: 'old',
    stats: { files: 40, nodes: 300, edges: 900 },
    ...overrides,
  };
}

const BEHIND = { isStale: true, commitsBehind: 3, status: 'behind', hint: 'behind' };
const CURRENT = { isStale: false, commitsBehind: 0, status: 'current' };

describe('LocalBackend refresh_index (#3524)', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // The assertions use the defaults, so an inherited setting must not leak in.
    vi.stubEnv('GITNEXUS_MCP_REFRESH_MAX_FILES', undefined);
    vi.stubEnv('GITNEXUS_MCP_REFRESH_TIMEOUT_MS', undefined);
    mocks.listRegisteredRepos.mockResolvedValue([entry()]);
    mocks.embeddingsFromGitnexusRc.mockResolvedValue({});
    mocks.checkStalenessAsync.mockImplementation(async (_path: string, commit: string) =>
      commit === 'new' ? CURRENT : BEHIND,
    );
    mocks.runAutoSyncAnalysis.mockImplementation(async () => {
      mocks.listRegisteredRepos.mockResolvedValue([
        entry({
          lastCommit: 'new',
          indexedAt: '2026-10-29T00:00:00.000Z',
          stats: { files: 41, nodes: 310, edges: 930 },
        }),
      ]);
      return { stats: { files: 41 } };
    });
    backend = new LocalBackend();
    await backend.init();
  });

  it('describes a dry run without starting the worker', async () => {
    const result = await backend.callTool('refresh_index', { repo: 'shop', dry_run: true });
    expect(result).toEqual({
      status: 'dry_run',
      repo: 'shop',
      indexedAt: '2026-10-01T00:00:00.000Z',
      lastCommit: 'old',
      staleness: expect.objectContaining({ status: 'behind', commitsBehind: 3 }),
      estimatedFiles: 40,
      maxFiles: 5_000,
      embeddings: false,
      wouldRefresh: true,
    });
    expect(mocks.runAutoSyncAnalysis).not.toHaveBeenCalled();
  });

  it('reports and forwards embeddings that .gitnexusrc asks for', async () => {
    mocks.embeddingsFromGitnexusRc.mockResolvedValue({ embeddings: true, embeddingsNodeLimit: 9 });
    const dryRun = await backend.callTool('refresh_index', { repo: 'shop', dry_run: true });
    expect(dryRun).toMatchObject({ embeddings: true, wouldRefresh: true });

    await backend.callTool('refresh_index', { repo: 'shop' });
    expect(mocks.runAutoSyncAnalysis.mock.calls[0][1]).toMatchObject({
      embeddings: true,
      embeddingsNodeLimit: 9,
    });
  });

  it('refuses to start when .gitnexusrc cannot be read', async () => {
    mocks.embeddingsFromGitnexusRc.mockRejectedValue(new Error('.gitnexusrc: invalid JSON'));
    for (const dry_run of [true, false]) {
      await expect(backend.callTool('refresh_index', { repo: 'shop', dry_run })).resolves.toEqual({
        error: 'Cannot refresh shop: .gitnexusrc: invalid JSON.',
      });
    }
    expect(mocks.runAutoSyncAnalysis).not.toHaveBeenCalled();
  });

  it('rebuilds index-only through the worker and reports before and after', async () => {
    const onProgress = vi.fn();
    const result = await backend.callTool('refresh_index', { repo: 'shop' }, { onProgress });

    expect(mocks.runAutoSyncAnalysis).toHaveBeenCalledTimes(1);
    const [repoPath, options, timeoutMs, runSignal, , , progress] =
      mocks.runAutoSyncAnalysis.mock.calls[0];
    expect(repoPath).toBe(REPO);
    expect(options).toEqual({
      skipAgentsMd: true,
      skipSkills: true,
      preserveExistingPdg: true,
      atomicIncremental: true,
    });
    expect(timeoutMs).toBe(600_000);
    // The worker never interrupts a started analysis, so no abort signal is passed.
    expect(runSignal).toBeUndefined();
    expect(progress).toBe(onProgress);

    expect(result).toEqual({
      status: 'refreshed',
      repo: 'shop',
      previous: {
        indexedAt: '2026-10-01T00:00:00.000Z',
        lastCommit: 'old',
        staleness: expect.objectContaining({ status: 'behind' }),
      },
      indexedAt: '2026-10-29T00:00:00.000Z',
      lastCommit: 'new',
      staleness: { status: 'current' },
      stats: { files: 41, nodes: 310, edges: 930 },
      durationMs: expect.any(Number),
    });
  });

  it('refuses a repository over the file limit, and one with no recorded count', async () => {
    vi.stubEnv('GITNEXUS_MCP_REFRESH_MAX_FILES', '39');
    const over = await backend.callTool('refresh_index', { repo: 'shop' });
    expect(over.error).toMatch(/had 40 files at its last index, over .* limit of 39/);

    const dryRun = await backend.callTool('refresh_index', { repo: 'shop', dry_run: true });
    expect(dryRun).toMatchObject({ wouldRefresh: false, refusal: over.error });

    mocks.listRegisteredRepos.mockResolvedValue([entry({ stats: undefined })]);
    await backend.init();
    vi.stubEnv('GITNEXUS_MCP_REFRESH_MAX_FILES', undefined);
    const unknown = await backend.callTool('refresh_index', { repo: REPO });
    expect(unknown.error).toMatch(/has no recorded file count/);

    vi.stubEnv('GITNEXUS_MCP_REFRESH_MAX_FILES', '0');
    await expect(backend.callTool('refresh_index', { repo: REPO })).resolves.toMatchObject({
      status: 'refreshed',
    });
    expect(mocks.runAutoSyncAnalysis).toHaveBeenCalledTimes(1);
  });

  it('runs one refresh per repository at a time', async () => {
    let finish!: () => void;
    mocks.runAutoSyncAnalysis.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ stats: {} }))),
    );
    const first = backend.callTool('refresh_index', { repo: 'shop' });
    await vi.waitFor(() => expect(mocks.runAutoSyncAnalysis).toHaveBeenCalled());

    const second = await backend.callTool('refresh_index', { repo: 'shop' });
    expect(second.error).toMatch(/already running/);
    await expect(
      backend.callTool('refresh_index', { repo: 'shop', dry_run: true }),
    ).resolves.toMatchObject({ wouldRefresh: false, inProgress: true });

    finish();
    await expect(first).resolves.toMatchObject({ status: 'refreshed' });
    // The slot is released, including after a failure.
    mocks.runAutoSyncAnalysis.mockRejectedValueOnce(new Error('Analysis timed out after 5ms.'));
    const failed = await backend.callTool('refresh_index', { repo: 'shop' });
    expect(failed.error).toMatch(/Refresh of shop failed: Analysis timed out after 5ms\./);
    await expect(backend.callTool('refresh_index', { repo: 'shop' })).resolves.toMatchObject({
      status: 'refreshed',
    });
  });

  it('reports a collapsed graph write as a failure, like analyze and serve', async () => {
    mocks.runAutoSyncAnalysis.mockImplementationOnce(async () => {
      mocks.listRegisteredRepos.mockResolvedValue([entry({ lastCommit: 'new' })]);
      return { stats: { files: 41 }, graphWriteCollapsed: { expected: 930, persisted: 12 } };
    });
    const result = await backend.callTool('refresh_index', { repo: 'shop' });
    expect(result).toEqual({
      error: expect.stringMatching(
        /^shop was indexed INCOMPLETELY: only 12 of 930 expected relationships are readable.*`gitnexus analyze --force`/,
      ),
    });
    // The registry is still re-read, so later tools see what is on disk.
    const list = await backend.callTool('list_repos', {});
    expect(list.repositories[0].lastCommit).toBe('new');
  });

  it('says when a timed-out worker was left running', async () => {
    mocks.runAutoSyncAnalysis.mockRejectedValueOnce(
      Object.assign(new Error('Analysis timed out after 5ms. The analyze worker did not exit'), {
        abandonedWorker: true,
      }),
    );
    const result = await backend.callTool('refresh_index', { repo: 'shop' });
    expect(result.error).toBe(
      'Refresh of shop failed: Analysis timed out after 5ms. The analyze worker did not exit. ' +
        'Its worker keeps running until the analysis finishes; a new refresh waits on its index lock. ' +
        'Run `gitnexus analyze` in the repository for the full log.',
    );
  });

  it('reports unknown staleness when the check itself fails', async () => {
    mocks.checkStalenessAsync.mockRejectedValue(new Error('git missing'));
    const result = await backend.callTool('refresh_index', { repo: 'shop', dry_run: true });
    expect(result.staleness).toEqual({ status: 'unknown' });
  });

  it('needs an explicit repo once several are indexed, dry runs included', async () => {
    mocks.listRegisteredRepos.mockResolvedValue([
      entry(),
      entry({
        name: 'blog',
        path: path.resolve('/work/blog'),
        storagePath: `${path.resolve('/work/blog')}/.gitnexus`,
      }),
    ]);
    vi.spyOn(process, 'cwd').mockReturnValue(REPO);
    // The cwd would pick `shop` for a read tool; refresh_index does not use it.
    await expect(
      backend.selectToolRepository(undefined, undefined, { allowCwdDefault: true }),
    ).resolves.toMatchObject({ name: 'shop' });
    for (const dry_run of [true, false]) {
      await expect(backend.callTool('refresh_index', { dry_run })).rejects.toThrow(
        /multiple repositories/i,
      );
    }
    expect(mocks.runAutoSyncAnalysis).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean dry_run', async () => {
    const result = await backend.callTool('refresh_index', { repo: 'shop', dry_run: 'true' });
    expect(result).toEqual({ error: 'Parameter "dry_run" must be a boolean.' });
    expect(mocks.runAutoSyncAnalysis).not.toHaveBeenCalled();
  });
});
