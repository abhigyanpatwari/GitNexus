import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const WINDOWS_FILE = 'variants/value_windows.go';
const WINDOWS_SOURCE = 'package variants\ntype Value struct {}\n';
const LINUX_OWNER = {
  owner: 'Struct:variants/value_linux.go:Value',
  method: 'Method:variants/method.go:Value.Run#0',
};
const SENTINEL_OWNER = {
  owner: 'Struct:other/value.go:Sentinel',
  method: 'Method:other/value.go:Sentinel.Keep#0',
};

async function readOwners(repo: string): Promise<Record<string, unknown>[]> {
  await initLbug(getStoragePaths(repo).lbugPath, { skipFts: true });
  try {
    return await executeQuery(
      "MATCH (s:Struct)-[r:CodeRelation]->(m:Method) WHERE r.type = 'HAS_METHOD' " +
        'RETURN s.id AS owner, m.id AS method ORDER BY owner, method',
    );
  } finally {
    await closeLbug();
  }
}

it('persists ownership changes between untouched siblings after deleting and readding a build variant', async () => {
  const temp = await createTempDir();
  try {
    const root = await fs.realpath(temp.dbPath);
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
    vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
    const repo = path.join(root, 'incremental');
    const coldRepo = path.join(root, 'cold');
    const sources = new Map([
      ['.gitignore', '.gitnexus/\n'],
      ['go.mod', 'module example.com/owners\n\ngo 1.22\n'],
      ['variants/value_linux.go', 'package variants\ntype Value struct {}\n'],
      [WINDOWS_FILE, WINDOWS_SOURCE],
      ['variants/method.go', 'package variants\nfunc (v Value) Run() {}\n'],
      ['other/value.go', 'package other\ntype Sentinel struct {}\nfunc (s Sentinel) Keep() {}\n'],
    ]);
    for (const target of [repo, coldRepo]) {
      for (const [file, source] of sources) {
        await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true });
        await fs.writeFile(path.join(target, file), source);
      }
      initGitRepo(target);
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: target });
      commitAll(target, 'ambiguous receiver owner');
    }
    const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
    const callbacks = { onProgress: () => {} };
    const expectColdParity = async (expected: Record<string, unknown>[]): Promise<void> => {
      // The control rebuilds from source with a fresh parser pass at each stage.
      await runFullAnalysis(coldRepo, { ...options, force: true, useParseCache: false }, callbacks);
      const cold = await readOwners(coldRepo);
      expect(cold).toEqual(expected);
      expect(await readOwners(repo)).toEqual(cold);
    };

    await runFullAnalysis(repo, options, callbacks);
    await expectColdParity([SENTINEL_OWNER]);

    // Neither endpoint of the newly resolved edge is edited. The only changed
    // path is gone, so it has no new-graph boundary edge or source to inspect.
    for (const target of [repo, coldRepo]) {
      await fs.unlink(path.join(target, WINDOWS_FILE));
      commitAll(target, 'remove Windows declaration');
    }
    const removed = await runFullAnalysis(repo, options, callbacks);
    expect(removed.incrementalStats).toMatchObject({
      changedFiles: 1,
      deletedFiles: 1,
      writeMode: 'incremental',
    });
    await expectColdParity([SENTINEL_OWNER, LINUX_OWNER]);

    // Ambiguity must also remove the stored edge; no current HAS_METHOD edge
    // remains for boundary expansion to discover either unchanged endpoint.
    for (const target of [repo, coldRepo]) {
      await fs.writeFile(path.join(target, WINDOWS_FILE), WINDOWS_SOURCE);
      commitAll(target, 'restore Windows declaration');
    }
    const restored = await runFullAnalysis(repo, options, callbacks);
    expect(restored.incrementalStats).toMatchObject({
      changedFiles: 1,
      deletedFiles: 0,
      writeMode: 'incremental',
    });
    await expectColdParity([SENTINEL_OWNER]);
  } finally {
    await closeLbug();
    vi.unstubAllEnvs();
    await temp.cleanup();
  }
}, 180_000);
