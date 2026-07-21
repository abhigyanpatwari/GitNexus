import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { tryResolveMoveFlowClient } from '../../src/core/move/mcp-client.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const requireMoveFlow = process.env.GITNEXUS_REQUIRE_MOVE_FLOW === '1';
const skipMoveFlow = process.env.GITNEXUS_SKIP_MOVE_FLOW === '1';
const canRun = requireMoveFlow || (!skipMoveFlow && tryResolveMoveFlowClient() !== null);

describe.skipIf(!canRun)('Move runFullAnalysis persistence', () => {
  it('provisions, persists, and queries a real mixed repository', async () => {
    const repo = await createTempDir('gitnexus-move-run-analyze-');
    const home = await createTempDir('gitnexus-move-run-analyze-home-');
    const previousHome = process.env.GITNEXUS_HOME;
    const previousExtensionPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    try {
      process.env.GITNEXUS_HOME = home.dbPath;
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
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

      await runFullAnalysis(
        repo.dbPath,
        {
          force: true,
          skipGit: true,
          skipAgentsMd: true,
          skipSkills: true,
          noStats: true,
          workerPoolSize: 2,
        },
        { onProgress: () => {} },
      );

      const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta?.moveIngestAvailable).toBe(true);
      expect(meta?.moveCompilerIdentity?.version).toMatch(/^2\./);

      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.initLbug(lbugPath);
      try {
        await expect(
          adapter.executeQuery(
            "MATCH (f:Function) WHERE f.qualifiedName = '0x42::main::start' " +
              'RETURN f.name AS name, f.isEntry AS isEntry',
          ),
        ).resolves.toEqual([{ name: 'start', isEntry: true }]);
        await expect(
          adapter.executeQuery(
            "MATCH (f:Function) WHERE f.name = 'helper' " +
              'RETURN f.language AS language, f.qualifiedName AS qualifiedName',
          ),
        ).resolves.toEqual([{ language: 'typescript', qualifiedName: null }]);
        await expect(
          adapter.executeQuery(
            "MATCH (m:Module)-[r:CodeRelation]->(f:Function) WHERE r.type = 'DEFINES' " +
              "AND f.qualifiedName = '0x42::main::start' " +
              'RETURN m.qualifiedName AS module, r.type AS type',
          ),
        ).resolves.toEqual([{ module: '0x42::main', type: 'DEFINES' }]);
        await expect(
          adapter.executeQuery(
            'MATCH (n) WITH n.id AS id, count(n) AS copies ' + 'WHERE copies > 1 RETURN id, copies',
          ),
        ).resolves.toEqual([]);
      } finally {
        await adapter.closeLbug();
      }
    } finally {
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      if (previousExtensionPolicy === undefined) {
        delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      } else {
        process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = previousExtensionPolicy;
      }
      await repo.cleanup();
      await home.cleanup();
    }
  }, 180_000);
});
