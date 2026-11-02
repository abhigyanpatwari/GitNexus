/** Real filesystem, graph and native FTS coverage for unchanged dirty analysis. */
import { execSync } from 'node:child_process';
import { writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { setupMiniRepo as setupSharedMiniRepo } from '../helpers/mini-repo.js';

const setupMiniRepo = () => setupSharedMiniRepo('gitnexus-dirty-snapshot-');

describe('unchanged dirty snapshot analysis', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('dirty snapshot fast path preserves the database bytes, call edges, and native FTS', async (ctx) => {
    const repo = await setupMiniRepo();
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const target = path.join(repo.dbPath, 'src/logger.ts');
      const dirtySource = `${await readFile(target, 'utf8')}\n// dirtysnapshotneedle\n`;
      await writeFile(target, dirtySource);
      const options = { skipAgentsMd: true, skipSkills: true };
      const indexed = await runFullAnalysis(repo.dbPath, options, { onProgress: () => {} });
      if (indexed.ftsSkipped) {
        if (process.env.GITNEXUS_REQUIRE_FTS === '1') throw new Error('Native FTS is required');
        ctx.skip('Packaged FTS is unavailable on this platform');
      }
      const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
      const readEvidence = async () => {
        await adapter.initLbug(lbugPath);
        try {
          return {
            calls: await adapter.executeQuery(
              "MATCH (a:Function)-[r:CodeRelation]->(b:Function) WHERE r.type = 'CALLS' " +
                'RETURN a.id AS source, b.id AS target ORDER BY source, target',
            ),
            search: await adapter.executeQuery(
              "CALL QUERY_FTS_INDEX('File', 'file_fts', 'dirtysnapshotneedle') " +
                'RETURN node.filePath AS filePath ORDER BY filePath',
            ),
          };
        } finally {
          await adapter.closeLbug();
        }
      };
      const evidence = await readEvidence();
      expect(evidence.calls.length).toBeGreaterThan(0);
      expect(evidence.search).toEqual([{ filePath: 'src/logger.ts' }]);
      const database = await readFile(lbugPath);
      const meta = await loadMeta(storagePath);
      const onProgress = vi.fn();

      const repeated = await runFullAnalysis(repo.dbPath, options, { onProgress });
      expect(repeated.alreadyUpToDate).toBe(true);
      expect(repeated.pipelineResult).toBeUndefined();
      expect(repeated.rebuildReasons).toEqual([]);
      expect(onProgress).not.toHaveBeenCalled();
      expect((await readFile(lbugPath)).equals(database)).toBe(true);
      expect(await loadMeta(storagePath)).toEqual(meta);
      expect(await readEvidence()).toEqual(evidence);

      // Same Git dirty path, different bytes: this must still run the pipeline.
      await writeFile(
        target,
        `${dirtySource}\nexport function nextDirtyVersion() { return 42; }\n`,
      );
      const edited = await runFullAnalysis(repo.dbPath, options, { onProgress: () => {} });
      expect(edited.alreadyUpToDate).toBeUndefined();
      expect(edited.incrementalStats).toMatchObject({ changedFiles: 1, writeMode: 'incremental' });
      await adapter.initLbug(lbugPath);
      try {
        expect(
          await adapter.executeQuery(
            "MATCH (f:Function {name: 'nextDirtyVersion'}) RETURN f.filePath AS filePath",
          ),
        ).toEqual([{ filePath: 'src/logger.ts' }]);
      } finally {
        await adapter.closeLbug();
      }
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it.each([
    'addition',
    'deletion',
    'rename',
    'restore-one-dirty-file',
    'hidden-edit',
    'ignored-scan-policy',
    'file-size-policy',
    'force',
    'interrupted-write',
    'scope-incomplete',
    'scope-unverified',
  ] as const)(
    'dirty snapshot fast path falls back for %s',
    async (change) => {
      const repo = await setupMiniRepo();
      vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
      try {
        const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
        // This policy file can change the scan without appearing in Git status.
        await writeFile(path.join(repo.dbPath, '.gitignore'), '.gitnexusignore\n');
        execSync('git add .gitignore', { cwd: repo.dbPath, stdio: 'pipe' });
        execSync(
          'git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -qm policy',
          {
            cwd: repo.dbPath,
            stdio: 'pipe',
          },
        );
        const target = path.join(repo.dbPath, 'src/logger.ts');
        const original = await readFile(target, 'utf8');
        await writeFile(target, `${original}\n// indexed dirty snapshot\n`);
        if (change === 'restore-one-dirty-file') {
          const handler = path.join(repo.dbPath, 'src/handler.ts');
          await writeFile(handler, `${await readFile(handler, 'utf8')}\n// also dirty\n`);
        }
        const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
        await runFullAnalysis(repo.dbPath, options, { onProgress: () => {} });
        expect(
          (await runFullAnalysis(repo.dbPath, options, { onProgress: () => {} })).alreadyUpToDate,
        ).toBe(true);
        const { storagePath } = getStoragePaths(repo.dbPath);

        switch (change) {
          case 'addition':
            await writeFile(
              path.join(repo.dbPath, 'src/added.ts'),
              'export const addedValue = 1;\n',
            );
            break;
          case 'deletion':
            await rm(path.join(repo.dbPath, 'src/formatter.ts'));
            break;
          case 'rename':
            execSync('git mv src/formatter.ts src/renamed.ts', { cwd: repo.dbPath, stdio: 'pipe' });
            break;
          case 'restore-one-dirty-file':
            await writeFile(target, original);
            break;
          case 'hidden-edit': {
            execSync('git update-index --assume-unchanged src/formatter.ts', {
              cwd: repo.dbPath,
              stdio: 'pipe',
            });
            const formatter = path.join(repo.dbPath, 'src/formatter.ts');
            await writeFile(formatter, `${await readFile(formatter, 'utf8')}\n// hidden edit\n`);
            break;
          }
          case 'ignored-scan-policy':
            await writeFile(path.join(repo.dbPath, '.gitnexusignore'), 'src/formatter.ts\n');
            break;
          case 'file-size-policy':
            vi.stubEnv('GITNEXUS_MAX_FILE_SIZE', '1024');
            break;
          case 'interrupted-write': {
            const meta = await loadMeta(storagePath);
            await saveMeta(storagePath, {
              ...meta!,
              incrementalInProgress: { startedAt: Date.now(), toWriteCount: 0 },
            });
            break;
          }
          case 'scope-incomplete':
          case 'scope-unverified': {
            const meta = await loadMeta(storagePath);
            await saveMeta(storagePath, {
              ...meta!,
              ...(change === 'scope-incomplete'
                ? { scopeExtractionFailures: { total: 1, paths: ['src/logger.ts'] } }
                : { scopeExtractionReceipt: undefined }),
            });
            break;
          }
          case 'force':
            break;
        }

        const refreshed = await runFullAnalysis(
          repo.dbPath,
          { ...options, force: change === 'force' },
          { onProgress: () => {} },
        );
        expect(refreshed.alreadyUpToDate).toBeUndefined();
        expect(refreshed.pipelineResult).toBeDefined();
        const hashes = (await loadMeta(storagePath))!.fileHashes!;
        if (change === 'addition') expect(hashes).toHaveProperty('src/added.ts');
        if (change === 'deletion' || change === 'rename' || change === 'ignored-scan-policy') {
          expect(hashes).not.toHaveProperty('src/formatter.ts');
        }
        if (change === 'rename') expect(hashes).toHaveProperty('src/renamed.ts');
        if (change === 'force') expect(refreshed.rebuildReasons).toContain('user-force');
        if (change === 'interrupted-write')
          expect(refreshed.rebuildReasons).toContain('interrupted-rebuild');
      } finally {
        await repo.cleanup();
      }
    },
    300_000,
  );

  it.each(['fresh', 'incremental'] as const)(
    'reconciles a file edited after %s parsing before accepting a dirty snapshot',
    async (mode) => {
      const repo = await setupMiniRepo();
      vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
      try {
        const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
        const pipeline = await import('../../src/core/ingestion/pipeline.js');
        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        const target = path.join(repo.dbPath, 'src/logger.ts');
        const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
        if (mode === 'incremental') {
          await runFullAnalysis(repo.dbPath, options, { onProgress: () => {} });
        }
        const dirtySource = `${await readFile(target, 'utf8')}\n// indexed dirty snapshot\n`;
        await writeFile(target, dirtySource);
        const runPipeline = pipeline.runPipelineFromRepo;
        const editDuringAnalysis = vi
          .spyOn(pipeline, 'runPipelineFromRepo')
          .mockImplementationOnce(async (...args) => {
            const result = await runPipeline(...args);
            await writeFile(target, `${dirtySource}\nexport function editedDuringAnalysis() {}\n`);
            return result;
          });
        try {
          await runFullAnalysis(repo.dbPath, options, { onProgress: () => {} });
        } finally {
          editDuringAnalysis.mockRestore();
        }

        const refreshed = await runFullAnalysis(repo.dbPath, options, { onProgress: () => {} });
        expect(refreshed.alreadyUpToDate).toBeUndefined();
        const { lbugPath } = getStoragePaths(repo.dbPath);
        await adapter.initLbug(lbugPath);
        try {
          expect(
            await adapter.executeQuery(
              "MATCH (f:Function {name: 'editedDuringAnalysis'}) RETURN f.filePath AS filePath",
            ),
          ).toEqual([{ filePath: 'src/logger.ts' }]);
        } finally {
          await adapter.closeLbug();
        }
        expect(
          (await runFullAnalysis(repo.dbPath, options, { onProgress: () => {} })).alreadyUpToDate,
        ).toBe(true);
      } finally {
        await repo.cleanup();
      }
    },
    300_000,
  );

  it('dirty snapshot fast path falls back when the coverage scan fails', async () => {
    const repo = await setupMiniRepo();
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const walker = await import('../../src/core/ingestion/filesystem-walker.js');
      const target = path.join(repo.dbPath, 'src/logger.ts');
      await writeFile(target, `${await readFile(target, 'utf8')}\n// indexed dirty snapshot\n`);
      const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
      await runFullAnalysis(repo.dbPath, options, { onProgress: () => {} });
      const scan = vi
        .spyOn(walker, 'walkRepositoryPaths')
        .mockRejectedValueOnce(new Error('unreadable directory'));
      try {
        const refreshed = await runFullAnalysis(repo.dbPath, options, { onProgress: () => {} });
        expect(refreshed.alreadyUpToDate).toBeUndefined();
        expect(refreshed.pipelineResult).toBeDefined();
      } finally {
        scan.mockRestore();
      }
    } finally {
      await repo.cleanup();
    }
  }, 300_000);
});
