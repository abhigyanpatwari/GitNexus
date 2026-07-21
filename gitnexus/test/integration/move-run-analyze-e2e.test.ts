import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { getMoveFlowInstallConfig } from '../../src/core/move/install.js';
import { ensureMoveFlowRuntime } from '../../src/core/move/provision.js';
import { MOVE_FLOW_RELEASE } from '../../src/core/move/release.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const requireMoveFlow = process.env.GITNEXUS_REQUIRE_MOVE_FLOW === '1';
const skipMoveFlow = process.env.GITNEXUS_SKIP_MOVE_FLOW === '1';
const runtime =
  !requireMoveFlow && skipMoveFlow
    ? null
    : await ensureMoveFlowRuntime({
        install: requireMoveFlow,
        onLog: requireMoveFlow
          ? (message) => console.info(`[move-run-analyze] ${message}`)
          : undefined,
      });
if (requireMoveFlow && !runtime) {
  throw new Error('GITNEXUS_REQUIRE_MOVE_FLOW=1 but MoveFlow provisioning failed');
}
const expectedCompilerIdentity = runtime?.identity;
await runtime?.client.shutdown();
const managedConfig =
  expectedCompilerIdentity?.source === 'release' ? await getMoveFlowInstallConfig() : null;
const managedCacheRoot = managedConfig
  ? path.dirname(path.dirname(managedConfig.installDir))
  : undefined;

const analysisOptions = {
  skipAgentsMd: true,
  skipSkills: true,
  noStats: true,
  workerPoolSize: 2,
} as const;

const analyze = (repoPath: string, force: boolean) =>
  runFullAnalysis(repoPath, { ...analysisOptions, force }, { onProgress: () => {} });

interface GraphSnapshot {
  nodes: Array<Record<string, unknown>>;
  relationships: Array<Record<string, unknown>>;
}

const queryGraphSnapshot = async (): Promise<GraphSnapshot> => ({
  nodes: (await executeQuery(
    'MATCH (n) RETURN labels(n) AS label, n AS node ORDER BY n.id',
  )) as Array<Record<string, unknown>>,
  relationships: (await executeQuery(
    'MATCH (source)-[relation:CodeRelation]->(target) ' +
      'RETURN source.id AS sourceId, target.id AS targetId, relation.type AS type, ' +
      'relation.confidence AS confidence, relation.reason AS reason, relation.step AS step ' +
      'ORDER BY sourceId, targetId, type, reason, step',
  )) as Array<Record<string, unknown>>,
});

const readGraphSnapshot = async (lbugPath: string): Promise<GraphSnapshot> => {
  await initLbug(lbugPath);
  try {
    return await queryGraphSnapshot();
  } finally {
    await closeLbug();
  }
};

const initializeGitRepo = (repoPath: string): void => {
  execFileSync('git', ['init', '-q'], { cwd: repoPath });
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=GitNexus Test',
      '-c',
      'user.email=test@gitnexus.local',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'initial',
    ],
    { cwd: repoPath },
  );
};

describe.skipIf(!expectedCompilerIdentity)('Move runFullAnalysis persistence', () => {
  it('preserves a real compiler-backed graph when the compiler disappears', async () => {
    const repo = await createTempDir('gitnexus-move-run-analyze-');
    const home = await createTempDir('gitnexus-move-run-analyze-home-');
    try {
      vi.stubEnv('GITNEXUS_HOME', home.dbPath);
      if (managedCacheRoot) vi.stubEnv('GITNEXUS_MOVE_FLOW_DIR', managedCacheRoot);
      vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
      await fs.mkdir(path.join(repo.dbPath, 'sources'), { recursive: true });
      await fs.writeFile(
        path.join(repo.dbPath, 'Move.toml'),
        '[package]\nname = "live_e2e"\nversion = "1.0.0"\n\n[addresses]\nlive = "0x42"\n',
      );
      await fs.writeFile(
        path.join(repo.dbPath, 'sources', 'main.move'),
        'module live::main { public entry fun start(_account: &signer) {} }\n',
      );
      await fs.writeFile(
        path.join(repo.dbPath, 'helper.ts'),
        'export function helper(): number { return 1; }\n',
      );
      initializeGitRepo(repo.dbPath);

      await analyze(repo.dbPath, true);

      const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta?.moveIngestAvailable).toBe(true);
      expect(meta?.moveCompilerIdentity).toEqual(expectedCompilerIdentity);
      if (requireMoveFlow) {
        expect(meta?.moveCompilerIdentity?.version).toBe(MOVE_FLOW_RELEASE.version);
      }

      let graphBeforeFailure: GraphSnapshot;
      await initLbug(lbugPath);
      try {
        await expect(
          executeQuery(
            "MATCH (f:Function) WHERE f.qualifiedName = '0x42::main::start' " +
              'RETURN f.name AS name, f.isEntry AS isEntry',
          ),
        ).resolves.toEqual([{ name: 'start', isEntry: true }]);
        await expect(
          executeQuery(
            "MATCH (f:Function) WHERE f.name = 'helper' " +
              'RETURN f.language AS language, f.qualifiedName AS qualifiedName',
          ),
        ).resolves.toEqual([{ language: 'typescript', qualifiedName: null }]);
        await expect(
          executeQuery(
            "MATCH (m:Module)-[r:CodeRelation]->(f:Function) WHERE r.type = 'DEFINES' " +
              "AND f.qualifiedName = '0x42::main::start' " +
              'RETURN m.qualifiedName AS module, r.type AS type',
          ),
        ).resolves.toEqual([{ module: '0x42::main', type: 'DEFINES' }]);
        await expect(
          executeQuery(
            'MATCH (n) WITH n.id AS id, count(n) AS copies ' + 'WHERE copies > 1 RETURN id, copies',
          ),
        ).resolves.toEqual([]);
        graphBeforeFailure = await queryGraphSnapshot();
      } finally {
        await closeLbug();
      }

      vi.stubEnv('MOVE_FLOW', path.join(repo.dbPath, 'missing-move-flow'));
      await fs.appendFile(path.join(repo.dbPath, 'helper.ts'), '// compiler unavailable\n');

      for (const force of [false, true]) {
        await expect(analyze(repo.dbPath, force)).rejects.toThrow(
          'move-flow is unavailable; the existing Move graph was left unchanged',
        );
        expect(await loadMeta(storagePath)).toEqual(meta);
        expect(await readGraphSnapshot(lbugPath)).toEqual(graphBeforeFailure);
      }
    } finally {
      vi.unstubAllEnvs();
      await repo.cleanup();
      await home.cleanup();
    }
  }, 180_000);
});
