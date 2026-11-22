/**
 * R: two files that each declare `setClass(..., contains = "VIRTUAL")` must not share one
 * placeholder node. The incremental writer follows only file-owned edges, so a placeholder owned
 * by one file made the next incremental analyse fail once that file was deleted or edited. Each
 * declaring file owns its own placeholder, so the edge stays inside one file.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

async function placeholders(repo: string): Promise<string[]> {
  await initLbug(getStoragePaths(repo).lbugPath, { skipFts: true });
  try {
    const rows = await executeQuery(
      "MATCH (c:Class) WHERE c.name = 'VIRTUAL' RETURN c.id AS id ORDER BY id",
    );
    return rows.map((row) => String(row.id));
  } finally {
    await closeLbug();
  }
}

async function extendsPlaceholder(repo: string): Promise<string[]> {
  await initLbug(getStoragePaths(repo).lbugPath, { skipFts: true });
  try {
    const rows = await executeQuery(
      "MATCH (a:Class)-[r:CodeRelation {type: 'EXTENDS'}]->(b:Class) WHERE b.name = 'VIRTUAL' RETURN a.name AS name ORDER BY name",
    );
    return rows.map((row) => String(row.name));
  } finally {
    await closeLbug();
  }
}

it('keeps incremental analyses working when two files name the VIRTUAL sentinel and one is deleted or edited', async () => {
  const temp = await createTempDir();
  try {
    const root = await fs.realpath(temp.dbPath);
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
    vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
    const repo = path.join(root, 'pkg');
    const sources = new Map([
      ['.gitignore', '.gitnexus/\n'],
      ['DESCRIPTION', 'Package: pk\nVersion: 0.1.0\nTitle: Fixture\n'],
      ['NAMESPACE', 'export(helper)\n'],
      ['R/a.R', 'setClass("Shape", contains = "VIRTUAL")\n'],
      ['R/b.R', 'setClass("Solid", contains = "VIRTUAL")\n'],
      ['R/c.R', 'helper <- function() 1\n'],
    ]);
    for (const [file, source] of sources) {
      await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await fs.writeFile(path.join(repo, file), source);
    }
    initGitRepo(repo);
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    commitAll(repo, 'package');
    const options = { skipAgentsMd: true, skipSkills: true, skipFts: true, registryName: 'pkg' };
    const callbacks = { onProgress: () => {} };

    await runFullAnalysis(repo, options, callbacks);
    // One placeholder per declaring file, each an EXTENDS target of its own class.
    expect(await placeholders(repo)).toHaveLength(2);
    expect(await extendsPlaceholder(repo)).toEqual(['Shape', 'Solid']);

    // Edit the file that used to own the shared placeholder.
    await fs.writeFile(
      path.join(repo, 'R/a.R'),
      'setClass("Shape", contains = "VIRTUAL")\n# edit\n',
    );
    commitAll(repo, 'edit a');
    await runFullAnalysis(repo, options, callbacks);
    expect(await extendsPlaceholder(repo)).toEqual(['Shape', 'Solid']);

    // Delete it.
    await fs.rm(path.join(repo, 'R/a.R'));
    commitAll(repo, 'delete a');
    await runFullAnalysis(repo, options, callbacks);
    expect(await placeholders(repo)).toHaveLength(1);
    expect(await extendsPlaceholder(repo)).toEqual(['Solid']);
  } finally {
    await closeLbug();
    vi.unstubAllEnvs();
    await temp.cleanup();
  }
}, 240_000);
