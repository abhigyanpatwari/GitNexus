/**
 * Clean Command
 *
 * Removes the .gitnexus index from the current repository.
 * Also unregisters it from the global registry.
 */

import fs from 'fs/promises';
import {
  findRepo,
  unregisterRepo,
  listRegisteredRepos,
  assertSafeStoragePath,
  UnsafeStoragePathError,
} from '../storage/repo-manager.js';

export const cleanCommand = async (options?: { force?: boolean; all?: boolean }) => {
  // --all flag: clean all indexed repos
  if (options?.all) {
    if (!options?.force) {
      const entries = await listRegisteredRepos();
      if (entries.length === 0) {
        console.log('No indexed repositories found.');
        return;
      }
      console.log(`This will delete GitNexus indexes for ${entries.length} repo(s):`);
      for (const entry of entries) {
        console.log(`  - ${entry.name} (${entry.path})`);
      }
      console.log('\nRun with --force to confirm deletion.');
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
          console.error(`Refusing to clean ${entry.name}: ${err.message}`);
          continue;
        }
        throw err;
      }

      try {
        await fs.rm(entry.storagePath, { recursive: true, force: true });
        await unregisterRepo(entry.path);
        console.log(`Deleted: ${entry.name} (${entry.storagePath})`);
      } catch (err) {
        console.error(`Failed to delete ${entry.name}:`, err);
      }
    }
    return;
  }

  // Default: clean current repo
  const cwd = process.cwd();
  const repo = await findRepo(cwd);

  if (!repo) {
    console.log('No indexed repository found in this directory.');
    return;
  }

  const repoName = repo.repoPath.split(/[/\\]/).pop() || repo.repoPath;

  if (!options?.force) {
    console.log(`This will delete the GitNexus index for: ${repoName}`);
    console.log(`   Path: ${repo.storagePath}`);
    console.log('\nRun with --force to confirm deletion.');
    return;
  }

  try {
    await fs.rm(repo.storagePath, { recursive: true, force: true });
    await unregisterRepo(repo.repoPath);
    console.log(`Deleted: ${repo.storagePath}`);
  } catch (err) {
    console.error('Failed to delete:', err);
  }
};
