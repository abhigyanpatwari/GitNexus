/**
 * R: after an edit to NAMESPACE alone, an incremental analyse keeps stale `isExported`.
 *
 * docs/languages/r-provider.md ("Not supported") says so: NAMESPACE is read from disk during
 * analysis but is not a parsed source file, so only changed sources are re-processed and the
 * persisted verdict of unchanged `R/` files survives. A full analyse (`force`) is correct. This
 * records both, so that a fix in the shared incremental write path shows up here and the
 * document is updated with it, rather than going stale.
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

async function exportedByName(repo: string): Promise<Record<string, unknown>> {
  await initLbug(getStoragePaths(repo).lbugPath, { skipFts: true });
  try {
    const rows = await executeQuery(
      'MATCH (f:Function) RETURN f.name AS name, f.isExported AS exported ORDER BY name',
    );
    return Object.fromEntries(rows.map((row) => [String(row.name), row.exported]));
  } finally {
    await closeLbug();
  }
}

it('keeps the persisted isExported of unchanged R/ files until a full analyse (documented limitation)', async () => {
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
      ['NAMESPACE', 'export(pub)\n'],
      ['R/pub.R', 'pub <- function() 1\n'],
      ['R/other.R', 'other <- function() 2\n'],
    ]);
    for (const [file, source] of sources) {
      await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await fs.writeFile(path.join(repo, file), source);
    }
    initGitRepo(repo);
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    commitAll(repo, 'package');
    const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
    const callbacks = { onProgress: () => {} };

    await runFullAnalysis(repo, options, callbacks);
    expect(await exportedByName(repo)).toEqual({ other: false, pub: true });

    // Export `other` as well, and touch no source file.
    await fs.writeFile(path.join(repo, 'NAMESPACE'), 'export(pub)\nexport(other)\n');
    commitAll(repo, 'export other');
    await runFullAnalysis(repo, options, callbacks);
    // The stale verdict: `other` is exported now, but the unchanged file was not re-processed.
    expect(await exportedByName(repo)).toEqual({ other: false, pub: true });

    await runFullAnalysis(repo, { ...options, force: true }, callbacks);
    expect(await exportedByName(repo)).toEqual({ other: true, pub: true });
  } finally {
    await closeLbug();
    vi.unstubAllEnvs();
    await temp.cleanup();
  }
}, 180_000);
