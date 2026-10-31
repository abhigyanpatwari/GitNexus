/**
 * Server reindex keeps configured Go routes (#3750 review).
 *
 * The HTTP analyze path forks a worker that bypasses the CLI config loader. If
 * the launch forwarded no route configuration, the rebuild gate would read the
 * omission as "configuration removed" and drop alias Routes and wrapped
 * HANDLES_ROUTE edges, even with the same `GITNEXUS_RC` in the environment.
 *
 * Drives CLI-style indexing, then the server path: options resolved by
 * `resolveLaunchRouteHookConfig` (what the launch forwards) and run through
 * `runWorkerAnalysis` (what the forked worker runs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { resolveLaunchRouteHookConfig } from '../../src/server/analyze-launch.js';
import { runWorkerAnalysis } from '../../src/server/analyze-worker-core.js';
import type { WorkerMessage } from '../../src/server/analyze-worker-protocol.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'go-wrapped-gin-route-app');

async function routeEvidence(repo: string): Promise<{ routes: number; handled: number }> {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  await adapter.initLbug(getStoragePaths(repo).lbugPath);
  try {
    const [routes] = (await adapter.executeQuery('MATCH (r:Route) RETURN count(r) AS n')) as Array<{
      n: number;
    }>;
    const [handled] = (await adapter.executeQuery(
      "MATCH (h:Method)-[e:CodeRelation]->(r:Route) WHERE e.type = 'HANDLES_ROUTE' " +
        'RETURN count(DISTINCT r) AS n',
    )) as Array<{ n: number }>;
    return { routes: Number(routes?.n ?? 0), handled: Number(handled?.n ?? 0) };
  } finally {
    await adapter.closeLbug();
  }
}

describe('server reindex with route aliases from GITNEXUS_RC', () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let repo: string;

  beforeAll(async () => {
    temp = await createTempDir();
    const root = await fs.realpath(temp.dbPath);
    const userHome = path.join(root, 'user-home');
    await fs.mkdir(userHome);
    vi.stubEnv('HOME', userHome);
    vi.stubEnv('USERPROFILE', userHome);
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
    vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
    vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '1');
    repo = path.join(root, 'repo');
    await fs.cp(FIXTURE, repo, { recursive: true });
    await fs.writeFile(path.join(repo, '.gitignore'), '.gitnexus/\n');
    initGitRepo(repo);
    commitAll(repo, 'wrapped gin fixture');
    const rc = path.join(root, 'service.json');
    await fs.writeFile(
      rc,
      JSON.stringify({
        goRouterAliases: [
          { importPath: 'example.com/infra/pkg', type: 'Engine', framework: 'gin' },
        ],
        goHandlerWrappers: ['common.Wrapper', 'common.WrapperWithSuccessCode'],
      }),
    );
    vi.stubEnv('GITNEXUS_RC', rc);
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await temp.cleanup();
  });

  it('keeps alias Routes and wrapped handler edges across an HTTP reindex', async () => {
    const routeHookConfig = resolveLaunchRouteHookConfig(repo);
    await runFullAnalysis(
      repo,
      { skipAgentsMd: true, skipSkills: true, routeHookConfig },
      { onProgress: () => {} },
    );
    expect(await routeEvidence(repo)).toEqual({ routes: 3, handled: 2 });

    const send = vi.fn<(message: WorkerMessage) => void>();
    await runWorkerAnalysis(
      repo,
      // Exactly what `createLaunchAnalysisWorker` sends for a forced reindex.
      { force: true, embeddings: false, dropEmbeddings: false, routeHookConfig },
      {
        runFullAnalysis: (repoPath, options, callbacks, ...rest) =>
          runFullAnalysis(
            repoPath,
            { ...options, skipNativeCloseOnExit: false },
            callbacks,
            ...rest,
          ),
        assertAnalysisFinalized: async () => undefined,
        send,
        claimTerminal: () => true,
      },
    );

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
    expect(await routeEvidence(repo)).toEqual({ routes: 3, handled: 2 });
  }, 300_000);

  it('drops them when a reindex really carries no configuration (the pre-fix launch)', async () => {
    await runFullAnalysis(
      repo,
      { skipAgentsMd: true, skipSkills: true, routeHookConfig: resolveLaunchRouteHookConfig(repo) },
      { onProgress: () => {} },
    );
    expect(await routeEvidence(repo)).toEqual({ routes: 3, handled: 2 });
    // The launch used to send only force/embeddings: the removal gate rebuilds without Routes.
    await runFullAnalysis(
      repo,
      { force: true, embeddings: false, dropEmbeddings: false, skipNativeCloseOnExit: false },
      { onProgress: () => {} },
    );
    expect(await routeEvidence(repo)).toEqual({ routes: 0, handled: 0 });
  }, 300_000);
});
