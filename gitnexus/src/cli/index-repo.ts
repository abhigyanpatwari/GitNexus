/**
 * Index Command
 *
 * Registers an existing GitNexus index into the global registry so the
 * MCP server can discover the repo without running a full `gitnexus analyze`.
 *
 * The index can be either:
 * - A per-worktree gitnexus.json file under .gitnexus/ (new format, worktree-compatible)
 * - A legacy .gitnexus/meta.json file (auto-migrated on analyze)
 *
 * Useful when a pre-built index is already present (e.g. after
 * cloning a repo that ships its index, restoring from backup, or using a
 * shared team index).
 */

import path from 'path';
import fs from 'fs/promises';
import {
  loadMeta,
  saveMeta,
  ensureGitNexusIgnored,
  registerRepo,
} from '../storage/repo-manager.js';
import { getGitRoot, getRemoteUrl, isGitRepo } from '../storage/git.js';
import {
  getIndexStorageRequirements,
  requireStoragePath,
  StorageRequirementError,
} from '../storage/storage-resolver.js';

export interface IndexOptions {
  force?: boolean;
  allowNonGit?: boolean;
}

export const indexCommand = async (inputPathParts?: string[], options?: IndexOptions) => {
  console.log('\n  GitNexus Index\n');

  const inputPath = inputPathParts?.length ? inputPathParts.join(' ') : undefined;

  if (inputPathParts && inputPathParts.length > 1) {
    const resolvedCombinedPath = path.resolve(inputPath);
    try {
      await fs.access(resolvedCombinedPath);
    } catch {
      console.log('  The `index` command accepts a single path only.');
      console.log('  If your path contains spaces, wrap it in quotes.');
      console.log(`  Received multiple path parts: ${inputPathParts.join(', ')}`);
      console.log('');
      process.exitCode = 1;
      return;
    }
  }

  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      console.log('  Not inside a git repository, try to run git init\n');
      process.exitCode = 1;
      return;
    }
    repoPath = gitRoot;
  }

  if (!options?.allowNonGit && !isGitRepo(repoPath)) {
    console.log(`  Not a git repository: ${repoPath}`);
    console.log('  Initialize one with `git init` or choose a valid repo path.\n');
    console.log('  Or use --allow-non-git to register an existing .gitnexus index anyway.\n');
    process.exitCode = 1;
    return;
  }

  let storagePath: string;
  try {
    storagePath = await requireStoragePath(repoPath, getIndexStorageRequirements(!!options?.force));
  } catch (error) {
    if (!(error instanceof StorageRequirementError)) {
      console.log(`  ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
      return;
    }
    const inspection = error.inspection;
    if (inspection.state === 'missing' || inspection.state === 'empty') {
      console.log(`  No GitNexus index found.`);
      console.log(
        `  Expected gitnexus.json, .gitnexus/meta.json, or LadybugDB at: ${inspection.storagePath}`,
      );
      console.log('  Run `gitnexus analyze` to build the index first.\n');
    } else if (inspection.state === 'unowned' && !options?.force) {
      console.log(`  gitnexus.json or .gitnexus/meta.json is missing.`);
      console.log('  Use --force to register anyway (stats will be empty),');
      console.log('  or run `gitnexus analyze` to rebuild properly.\n');
    } else if (!inspection.hasCodeIndexDB) {
      console.log(`  Index exists but contains no LadybugDB database.`);
      console.log('  Run `gitnexus analyze` to build the index.\n');
    } else {
      console.log(`  ${error.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  // ── Load or reconstruct meta ──────────────────────────────────────
  let meta = await loadMeta(storagePath);
  let reconstructedMeta = false;

  if (!meta) {
    if (!options?.force) {
      console.log(`  gitnexus.json or .gitnexus/meta.json is missing.`);
      console.log('  Use --force to register anyway (stats will be empty),');
      console.log('  or run `gitnexus analyze` to rebuild properly.\n');
      process.exitCode = 1;
      return;
    }

    // --force: build a minimal meta so the repo can be registered
    meta = {
      repoPath,
      storagePath,
      lastCommit: '',
      indexedAt: new Date().toISOString(),
    };
    reconstructedMeta = true;
  }

  // `index --force` is the explicit adoption path for an existing external
  // database whose legacy metadata predates storagePath binding, and for a
  // repository-local slot whose metadata still names another checkout.
  if (options?.force) {
    const adoptedRepoPath = path.resolve(repoPath);
    const adoptedStoragePath = path.resolve(storagePath);
    const ownershipChanged =
      path.resolve(meta.repoPath) !== adoptedRepoPath ||
      meta.storagePath === undefined ||
      path.resolve(meta.storagePath) !== adoptedStoragePath;
    if (ownershipChanged) {
      meta = { ...meta, repoPath: adoptedRepoPath, storagePath: adoptedStoragePath };
      reconstructedMeta = true;
    }
  }

  // ── Register in global registry ───────────────────────────────────
  // Refresh the on-disk meta with a freshly captured `remoteUrl` if
  // it's missing, so an `index` of an older `.gitnexus/` still gets
  // sibling-clone fingerprinting on subsequent use without forcing a
  // full re-analyze.
  if (!meta.remoteUrl && isGitRepo(repoPath)) {
    meta.remoteUrl = getRemoteUrl(repoPath);
  }
  if (reconstructedMeta) {
    await saveMeta(storagePath, meta);
  }
  await registerRepo(repoPath, meta, { storagePath });
  await ensureGitNexusIgnored(repoPath, storagePath);

  const projectName = path.basename(repoPath);
  const { stats } = meta;

  console.log(`  Repository registered: ${projectName}`);
  if (stats) {
    const parts: string[] = [];
    if (stats.nodes != null) {
      parts.push(`${stats.nodes.toLocaleString()} nodes`);
    }
    if (stats.edges != null) {
      parts.push(`${stats.edges.toLocaleString()} edges`);
    }
    if (stats.communities != null) parts.push(`${stats.communities} clusters`);
    if (stats.processes != null) parts.push(`${stats.processes} flows`);
    if (parts.length) console.log(`  ${parts.join(' | ')}`);
  }
  console.log(`  ${repoPath}`);

  console.log('');
};
