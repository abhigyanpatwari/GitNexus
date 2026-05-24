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
  UnsafeStoragePathError,
} from '../storage/repo-manager.js';
import {
  cleanQuarantinedMissingShadowWals,
  inspectLbugSidecars,
  listQuarantinedMissingShadowWals,
} from '../core/lbug/sidecar-recovery.js';
import { t } from './i18n/index.js';

export const cleanCommand = async (options?: {
  force?: boolean;
  all?: boolean;
  lbugSidecars?: boolean;
}) => {
  if (options?.lbugSidecars) {
    const cwd = process.cwd();
    const repo = await findRepo(cwd);

    if (!repo) {
      console.log(t('clean.notFoundHere'));
      return;
    }

    const lbugPath = path.join(repo.storagePath, 'lbug');
    const state = await inspectLbugSidecars(lbugPath);
    const quarantined = await listQuarantinedMissingShadowWals(lbugPath);

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

    const deleted = await cleanQuarantinedMissingShadowWals(lbugPath);
    console.log(t('clean.lbugSidecars.deleted', { count: deleted.length }));
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
