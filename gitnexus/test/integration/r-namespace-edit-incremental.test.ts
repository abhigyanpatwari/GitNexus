/**
 * R: after an edit to NAMESPACE alone, an incremental analyse keeps the persisted `isExported` of
 * the unchanged `R/` files, because NAMESPACE is read from disk during analysis but is not a
 * parsed source file. That stale flag must not decide a rename: the rename planner reads the
 * NAMESPACE on disk again and refuses a function it exports, whatever the index says. A full
 * analyse (`force`) repairs the flag itself. This pins all three: the stale flag (so that a fix in
 * the shared incremental write path shows up here), the refusal on the stale index, and the same
 * refusal on the repaired one.
 *
 * `other.R` also calls an external package (`stats::sd`), whose call site the qualified-call pass
 * drops and so replaces the file's ParsedFile; the plan-time NAMESPACE read must survive that, on
 * a full run and after an incremental one that re-uses the parse cache for the unchanged files.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

async function idsByName(repo: string): Promise<Record<string, string>> {
  await initLbug(getStoragePaths(repo).lbugPath, { skipFts: true });
  try {
    const rows = await executeQuery('MATCH (f:Function) RETURN f.name AS name, f.id AS id');
    return Object.fromEntries(rows.map((row) => [String(row.name), String(row.id)]));
  } finally {
    await closeLbug();
  }
}

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

it('refuses to rename a function that a NAMESPACE-only edit exported, on a stale index and after --force', async () => {
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
      ['R/other.R', 'other <- function() stats::sd(c(2, 3))\n'],
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
    const backend = new LocalBackend();
    /** Preview renaming `other`, as the rename tool does; `other.R` is read back to see it untouched. */
    const previewRename = async () => {
      expect(await backend.init()).toBe(true);
      const id = (await idsByName(repo)).other;
      const preview = (await backend.callTool('rename', {
        repo: 'pkg',
        symbol_uid: id,
        new_name: 'other_renamed',
        dry_run: true,
      })) as { status: string; code?: string; planning_status?: string; total_edits: number };
      expect(await fs.readFile(path.join(repo, 'R/other.R'), 'utf8')).toBe(
        'other <- function() stats::sd(c(2, 3))\n',
      );
      return preview;
    };

    await runFullAnalysis(repo, options, callbacks);
    expect(await exportedByName(repo)).toEqual({ other: false, pub: true });
    // NAMESPACE exports `pub` only: renaming the private `other` is allowed.
    expect(await previewRename()).toMatchObject({ status: 'success' });

    // An incremental run that adds an unrelated file re-uses the parse cache of the others; the
    // private `other` still renames.
    await fs.writeFile(path.join(repo, 'R/extra.R'), 'extra <- function() 3\n');
    commitAll(repo, 'add extra');
    await runFullAnalysis(repo, options, callbacks);
    expect(await previewRename()).toMatchObject({ status: 'success' });

    // Export `other` as well, and touch no source file.
    await fs.writeFile(path.join(repo, 'NAMESPACE'), 'export(pub)\nexport(other)\n');
    commitAll(repo, 'export other');
    await runFullAnalysis(repo, options, callbacks);
    // The stale verdict: `other` is exported now, but the unchanged file was not re-processed.
    expect(await exportedByName(repo)).toEqual({ extra: false, other: false, pub: true });
    // ... and the rename planner does not trust it: it reads NAMESPACE again and refuses.
    expect(await previewRename()).toMatchObject({
      status: 'error',
      planning_status: 'unsupported',
      code: 'unsupported_occurrence',
      total_edits: 0,
    });

    await runFullAnalysis(repo, { ...options, force: true }, callbacks);
    expect(await exportedByName(repo)).toEqual({ extra: false, other: true, pub: true });
    // The repaired index refuses too: `other` is exported.
    expect(await previewRename()).toMatchObject({
      status: 'error',
      planning_status: 'unsupported',
      code: 'unsupported_occurrence',
      total_edits: 0,
    });
  } finally {
    await closeLbug();
    vi.unstubAllEnvs();
    await temp.cleanup();
  }
}, 180_000);
