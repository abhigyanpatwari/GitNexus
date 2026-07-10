/**
 * Clean Command
 *
 * Removes the .gitnexus index from the current repository.
 * Also unregisters it from the global registry.
 */

import fs from 'fs/promises';
import path from 'path';
import { logger } from '../core/logger.js';
import {
  findRepo,
  unregisterRepo,
  listRegisteredRepos,
  assertSafeStoragePath,
  getStoragePaths,
  removeBranchIndex,
  UnsafeStoragePathError,
} from '../storage/repo-manager.js';
import {
  cleanParkedLbugSidecars,
  inspectLbugSidecars,
  listParkedLbugSidecars,
} from '../core/lbug/sidecar-recovery.js';
import { t } from './i18n/index.js';

export const cleanCommand = async (options?: {
  force?: boolean;
  all?: boolean;
  lbugSidecars?: boolean;
  branch?: string;
}) => {
  // --branch <name>: remove a single non-primary branch's index (#2106 R7).
  // Resolve against the RECORDED branches[] summary (never by slugging the
  // user's raw input, which can disagree with the index-time-sanitized label).
  if (options?.branch) {
    const cwd = process.cwd();
    const repo = await findRepo(cwd);
    if (!repo) {
      console.log(t('clean.notFoundHere'));
      return;
    }
    const entries = await listRegisteredRepos();
    const entry = entries.find((e) => path.resolve(e.path) === path.resolve(repo.repoPath));
    const summary = entry?.branches?.find((b) => b.branch === options.branch);
    if (!summary) {
      console.log(t('clean.branchNotIndexed', { branch: options.branch }));
      return;
    }
    const { storagePath, lbugPath } = getStoragePaths(repo.repoPath, summary.branch);
    const branchDir = path.dirname(lbugPath);
    // Safety guard: the target MUST live under <repo>/.gitnexus/branches/.
    // assertSafeStoragePath only validates the flat `<repo>/.gitnexus`, so this
    // is a dedicated branches-sub-dir check before any destructive fs.rm.
    const branchesRoot = path.join(storagePath, 'branches') + path.sep;
    if (!branchDir.startsWith(branchesRoot)) {
      logger.error(`Refusing to clean branch index outside .gitnexus/branches: ${branchDir}`);
      return;
    }
    if (!options.force) {
      console.log(t('clean.deleteBranch', { branch: summary.branch, path: branchDir }));
      console.log(`\n${t('common.runForceConfirm')}`);
      return;
    }
    try {
      await fs.rm(branchDir, { recursive: true, force: true });
      await removeBranchIndex(repo.repoPath, summary.branch);
      console.log(t('clean.deletedBranch', { branch: summary.branch }));
    } catch (err) {
      logger.error({ err }, 'Failed to delete branch index:');
    }
    return;
  }

  if (options?.lbugSidecars) {
    const cwd = process.cwd();
    const repo = await findRepo(cwd);

    if (!repo) {
      console.log(t('clean.notFoundHere'));
      return;
    }

    const lbugPath = path.join(repo.storagePath, 'lbug');
    const state = await inspectLbugSidecars(lbugPath);
    // Single roster authority (this shipping review, FIX 5): the aggregate
    // covers both parked-sidecar families — the timestamped missing-shadow
    // WAL quarantines AND the fixed-name `.dirty-recovery` parks (`.next`
    // residues included) left by a dirty-flag recovery rebuild (#2409). The
    // previous inline concatenations here were how the `.next` residue
    // stayed invisible to this surface.
    const quarantined = await listParkedLbugSidecars(lbugPath);

    console.log(t('clean.lbugSidecars.state', { state: state.kind }));
    if (quarantined.length === 0) {
      console.log(t('clean.lbugSidecars.none'));
      return;
    }

    if (!options.force) {
      console.log(t('clean.lbugSidecars.preview', { count: quarantined.length }));
      for (const file of quarantined) {
        console.log(`  - ${file}`);
      }
      console.log(`\n${t('common.runForceConfirm')}`);
      return;
    }

    const { deleted, failed } = await cleanParkedLbugSidecars(lbugPath);
    console.log(t('clean.lbugSidecars.deleted', { count: deleted.length }));
    // A locked parked file no longer crashes the clean mid-command (FIX 5)
    // — the rest were deleted above; report what remains and why.
    if (failed.length > 0) {
      console.log(t('clean.lbugSidecars.failed', { count: failed.length }));
      for (const file of failed) {
        console.log(`  - ${file}`);
      }
    }
    return;
  }

  // --all flag: clean all indexed repos
  if (options?.all) {
    if (!options?.force) {
      const entries = await listRegisteredRepos();
      if (entries.length === 0) {
        console.log(t('common.notIndexed'));
        return;
      }
      console.log(t('clean.deleteAll', { count: entries.length }));
      for (const entry of entries) {
        console.log(`  - ${entry.name} (${entry.path})`);
      }
      console.log(`\n${t('common.runForceConfirm')}`);
      return;
    }

    const entries = await listRegisteredRepos();
    for (const entry of entries) {
      // Safety guard (#1003 review — @magyargergo): same rationale as
      // remove.ts. `~/.gitnexus/registry.json` is user-writable, so a
      // corrupted or hand-edited entry could point storagePath at the
      // repo root, an empty string, or anywhere else — and
      // fs.rm(recursive: true) on any of those would be catastrophic.
      // Skip poisoned entries without touching disk, but keep going
      // through the rest of the registry (preserves the existing
      // per-repo error-tolerance semantics of `clean --all`).
      try {
        assertSafeStoragePath(entry);
      } catch (err) {
        if (err instanceof UnsafeStoragePathError) {
          logger.error(`Refusing to clean ${entry.name}: ${err.message}`);
          continue;
        }
        throw err;
      }

      try {
        await fs.rm(entry.storagePath, { recursive: true, force: true });
        await unregisterRepo(entry.path);
        console.log(t('clean.deletedRepo', { name: entry.name, storagePath: entry.storagePath }));
      } catch (err) {
        logger.error({ err }, `Failed to delete ${entry.name}:`);
      }
    }
    return;
  }

  // Default: clean current repo
  const cwd = process.cwd();
  const repo = await findRepo(cwd);

  if (!repo) {
    console.log(t('clean.notFoundHere'));
    return;
  }

  const repoName = repo.repoPath.split(/[/\\]/).pop() || repo.repoPath;

  if (!options?.force) {
    console.log(t('clean.deleteCurrent', { repoName }));
    console.log(`   ${t('common.path')}: ${repo.storagePath}`);
    console.log(`\n${t('common.runForceConfirm')}`);
    return;
  }

  try {
    await fs.rm(repo.storagePath, { recursive: true, force: true });
    await unregisterRepo(repo.repoPath);
    console.log(t('common.deleted', { target: repo.storagePath }));
  } catch (err) {
    logger.error({ err }, 'Failed to delete:');
  }
};
