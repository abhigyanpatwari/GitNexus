import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnalyzerRunnerIdentity } from '../../src/storage/repo-manager.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { createTempDir } from '../helpers/test-db.js';
import { normalizeAnalyzerRunnerIdentityForComparison } from '../../src/core/analyzer-identity.js';

function runAnalyzeWorker(
  workerEntry: string,
  repoPath: string,
  env: NodeJS.ProcessEnv,
  force: boolean,
): Promise<{ alreadyUpToDate?: boolean }> {
  return new Promise((resolve, reject) => {
    const child = fork(workerEntry, [], {
      cwd: repoPath,
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`analyze worker timed out: ${stderr}`));
    }, 240_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('message', (message: unknown) => {
      const result = message as {
        type?: string;
        message?: string;
        result?: { alreadyUpToDate?: boolean };
      };
      if (result.type === 'complete') {
        clearTimeout(timer);
        resolve(result.result ?? {});
      } else if (result.type === 'error') {
        clearTimeout(timer);
        reject(new Error(result.message ?? stderr));
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.send({
      type: 'start',
      repoPath,
      options: {
        force,
        skipAgentsMd: true,
        skipSkills: true,
        workerCount: 1,
      },
    });
  });
}

describe('CLI analyzer identity receipt', () => {
  it('keeps CLI and server-worker entrypoints fresh in both directions', async () => {
    const repo = await setupMiniRepo();
    const isolatedHome = await createTempDir();
    const packageRoot = path.resolve(__dirname, '..', '..');
    const cliEntry = await realpath(path.join(packageRoot, 'dist', 'cli', 'index.js'));
    const workerEntry = await realpath(
      path.join(packageRoot, 'dist', 'server', 'analyze-worker.js'),
    );
    const runtimePath = await realpath(process.execPath);
    const packageVersion = (
      JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    const env = {
      ...process.env,
      GITNEXUS_HOME: isolatedHome.dbPath,
      GITNEXUS_LANG: 'en',
      GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
    };

    try {
      execFileSync(
        process.execPath,
        [cliEntry, 'analyze', repo.dbPath, '--index-only', '--force', '--workers', '1'],
        { cwd: packageRoot, env, stdio: 'pipe', timeout: 240_000 },
      );

      const meta = await loadMeta(getStoragePaths(repo.dbPath).storagePath);
      expect(meta?.runnerIdentity).toMatchObject({
        schemaVersion: 4,
        runtime: {
          executablePath: runtimePath,
          version: process.version,
          platform: process.platform,
          architecture: process.arch,
          modulesAbi: process.versions.modules ?? 'unknown',
          libc: expect.any(String),
        },
        cliVersion: packageVersion,
        invokedArtifact: {
          path: cliEntry,
          digest: `sha256:${createHash('sha256')
            .update(await readFile(cliEntry))
            .digest('hex')}`,
        },
        build: {
          kind: 'distribution',
          rootPath: path.join(packageRoot, 'dist'),
          canonicalization: 'gitnexus-analyzer-build-v2',
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        dependencyRuntime: {
          manifestPath: path.join(packageRoot, 'package.json'),
          lockfilePath: path.join(packageRoot, 'package-lock.json'),
          canonicalization: 'gitnexus-analyzer-dependency-runtime-v4',
          packageCount: expect.any(Number),
          artifactCount: expect.any(Number),
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      });

      // A server worker sees a different process.argv[1], but that entrypoint
      // is diagnostic and already covered by the common build digest. It must
      // take the unchanged fast path after a CLI-authored index.
      const workerFastPath = await runAnalyzeWorker(workerEntry, repo.dbPath, env, false);
      expect(workerFastPath.alreadyUpToDate).toBe(true);
      expect((await loadMeta(getStoragePaths(repo.dbPath).storagePath))?.runnerIdentity).toEqual(
        meta?.runnerIdentity,
      );

      // Reverse the author: a forced worker run stamps its own entrypoint, and
      // both CLI status and CLI analyze must still regard the semantic runner
      // identity as current rather than rebuilding solely to swap diagnostics.
      await runAnalyzeWorker(workerEntry, repo.dbPath, env, true);
      const workerMeta = await loadMeta(getStoragePaths(repo.dbPath).storagePath);
      expect(workerMeta?.runnerIdentity?.invokedArtifact.path).toBe(workerEntry);

      const status = execFileSync(process.execPath, [cliEntry, 'status', '--json'], {
        cwd: repo.dbPath,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const parsedStatus = JSON.parse(status) as {
        index: {
          runnerIdentity: AnalyzerRunnerIdentity | null;
          runnerIdentityStatus: string;
        };
        current: { runnerIdentity: AnalyzerRunnerIdentity };
        status: string;
      };
      expect(parsedStatus.index.runnerIdentity).toEqual(workerMeta?.runnerIdentity);
      expect(parsedStatus.current.runnerIdentity.invokedArtifact.path).toBe(cliEntry);
      expect(parsedStatus.current.runnerIdentity).not.toEqual(workerMeta?.runnerIdentity);
      expect(
        normalizeAnalyzerRunnerIdentityForComparison(parsedStatus.current.runnerIdentity),
      ).toEqual(normalizeAnalyzerRunnerIdentityForComparison(workerMeta?.runnerIdentity));
      expect(parsedStatus.index.runnerIdentityStatus).toBe('current');
      expect(parsedStatus.status).toBe('up-to-date');

      execFileSync(
        process.execPath,
        [cliEntry, 'analyze', repo.dbPath, '--index-only', '--workers', '1'],
        {
          cwd: packageRoot,
          env,
          stdio: 'pipe',
          timeout: 240_000,
        },
      );
      expect((await loadMeta(getStoragePaths(repo.dbPath).storagePath))?.runnerIdentity).toEqual(
        workerMeta?.runnerIdentity,
      );
    } finally {
      await repo.cleanup();
      await isolatedHome.cleanup();
    }
  }, 300_000);
});
