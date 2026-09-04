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
  getStoragePaths,
  removeBranchIndex,
} from '../storage/repo-manager.js';
import { requireDeletableStoragePath, StorageDeletionError } from '../storage/storage-resolver.js';
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
    let storagePath: string;
    try {
      storagePath = await requireDeletableStoragePath({
        path: repo.repoPath,
        storagePath: repo.storagePath,
      });
    } catch (err) {
      if (err instanceof StorageDeletionError) {
        logger.error(`Refusing to clean branch index: ${err.message}`);
        return;
      }
      throw err;
    }
    const { lbugPath } = getStoragePaths(repo.repoPath, summary.branch, storagePath);
    const branchDir = path.dirname(lbugPath);
    // Safety guard: the target MUST live under the validated
    // `<repo>/.gitnexus/branches/` directory before any destructive fs.rm.
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

    let storagePath: string;
    try {
      storagePath = await requireDeletableStoragePath({
        path: repo.repoPath,
        storagePath: repo.storagePath,
      });
    } catch (err) {
      if (err instanceof StorageDeletionError) {
        logger.error(`Refusing to clean sidecars: ${err.message}`);
        return;
      }
      throw err;
    }
    const lbugPath = path.join(storagePath, 'lbug');
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
    const entries = await listRegisteredRepos();
    if (!options?.force) {
      const deletableEntries = [];
      for (const entry of entries) {
        try {
          await requireDeletableStoragePath(entry);
          deletableEntries.push(entry);
        } catch (err) {
          if (err instanceof StorageDeletionError) {
            logger.error(`Refusing to preview ${entry.name}: ${err.message}`);
            continue;
          }
          throw err;
        }
      }
      if (deletableEntries.length === 0) {
        console.log(t('common.notIndexed'));
        return;
      }
      console.log(t('clean.deleteAll', { count: deletableEntries.length }));
      for (const entry of deletableEntries) {
        console.log(`  - ${entry.name} (${entry.path})`);
      }
      console.log(`\n${t('common.runForceConfirm')}`);
      return;
    }

    for (const entry of entries) {
      try {
        const storagePath = await requireDeletableStoragePath(entry);
        await fs.rm(storagePath, { recursive: true, force: true });
        await unregisterRepo(entry.path);
        console.log(t('clean.deletedRepo', { name: entry.name, storagePath }));
      } catch (err) {
        if (err instanceof StorageDeletionError) {
          logger.error(`Refusing to clean ${entry.name}: ${err.message}`);
          continue;
        }
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
  let storagePath: string;
  try {
    storagePath = await requireDeletableStoragePath({
      path: repo.repoPath,
      storagePath: repo.storagePath,
    });
  } catch (err) {
    if (err instanceof StorageDeletionError) {
      logger.error(`Refusing to clean ${repoName}: ${err.message}`);
      return;
    }
    throw err;
  }

  if (!options?.force) {
    console.log(t('clean.deleteCurrent', { repoName }));
    console.log(`   ${t('common.path')}: ${storagePath}`);
    console.log(`\n${t('common.runForceConfirm')}`);
    return;
  }

  try {
    await fs.rm(storagePath, { recursive: true, force: true });
    await unregisterRepo(repo.repoPath);
    console.log(t('common.deleted', { target: storagePath }));
  } catch (err) {
    logger.error({ err }, 'Failed to delete:');
  }
};
