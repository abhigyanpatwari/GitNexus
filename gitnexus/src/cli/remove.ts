/**
 * Remove Command (#664)
 *
 * Delete the `.gitnexus/` index for a registered repo and unregister it
 * from the global registry (~/.gitnexus/registry.json). The target is
 * identified by alias / basename-derived name / remote-inferred name /
 * absolute path — no `--repo` flag, just a positional argument so the
 * destructive-command ergonomics match `clean` (which is also
 * destructive but scoped to `process.cwd()`).
 *
 * Compared to `clean`:
 *   - `clean`  acts on the repo discovered by walking up from cwd.
 *   - `remove` acts on any registered repo identified by name or path.
 *
 * Behaviour notes:
 *   - Idempotent on unknown targets: exits 0 with a warning so that
 *     `remove X && analyze Y` keeps working in scripts. Per #664:
 *     "behave atomically and idempotently so retries are safe".
 *   - Atomic order mirrors `clean`: fs.rm FIRST, then unregister. A
 *     partial failure leaves the registry pointing at a missing dir
 *     (recoverable by `listRegisteredRepos({ validate: true })` on
 *     next read) rather than the opposite, which would orphan
 *     .gitnexus/ directories on disk.
 *   - `-f` / `--force` matches the confirmation-skip semantics of
 *     `clean -f`. (Distinct from `analyze --force`, which re-indexes;
 *     here there is no pipeline, so no conflation.)
 */

import fs from 'fs/promises';
import {
  readRegistry,
  resolveRegistryEntry,
  assertSafeStoragePath,
  unregisterRepo,
  RegistryNotFoundError,
  RegistryAmbiguousTargetError,
  UnsafeStoragePathError,
} from '../storage/repo-manager.js';

export const removeCommand = async (target: string, options?: { force?: boolean }) => {
  // Read the registry snapshot once and pass it to the resolver — this
  // lets us render the "before" state in the dry-run path without a
  // second disk read.
  const entries = await readRegistry();

  let entry;
  try {
    entry = resolveRegistryEntry(entries, target);
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      // Idempotent: missing target is a no-op warning, not an error.
      // The `availableNames` hint comes from the error itself so users
      // can see what they might have meant.
      console.warn(`Nothing to remove: ${err.message}`);
      return;
    }
    if (err instanceof RegistryAmbiguousTargetError) {
      // Duplicate aliases are allowed via --allow-duplicate-name (#829);
      // refuse to guess which one the user meant — surface the full list
      // and exit non-zero so scripts don't silently pick the wrong repo.
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Confirmation gate — same shape as `clean`. Default is a dry-run
  // that describes what would be deleted; `--force` actually deletes.
  if (!options?.force) {
    console.log(`This will delete the GitNexus index for: ${entry.name}`);
    console.log(`   Path:    ${entry.path}`);
    console.log(`   Storage: ${entry.storagePath}`);
    console.log('\nRun with --force to confirm deletion.');
    return;
  }

  // Safety guard (#1003 review — @magyargergo): refuse to proceed if
  // the registry entry's `storagePath` isn't the canonical
  // `<entry.path>/.gitnexus` subfolder. `~/.gitnexus/registry.json` is
  // user-writable, so a corrupted or hand-edited entry could point
  // storagePath at the repo root, an empty string (→ cwd), a parent
  // dir, or anywhere else; `fs.rm(recursive: true, force: true)` on
  // any of those would be a runtime disaster. Bail before touching
  // disk, with an actionable hint for recovering a broken registry.
  try {
    assertSafeStoragePath(entry);
  } catch (err) {
    if (err instanceof UnsafeStoragePathError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Deletion order: fs.rm first, then unregister. If fs.rm fails mid-way,
  // the registry entry stays so the user can retry. If fs.rm succeeds but
  // unregister throws (e.g. ENOSPC on registry write), the entry becomes
  // orphaned — `listRegisteredRepos({ validate: true })` prunes those on
  // next read, so the failure is self-healing.
  try {
    await fs.rm(entry.storagePath, { recursive: true, force: true });
    await unregisterRepo(entry.path);
    console.log(`Removed: ${entry.name}`);
    console.log(`   Path:    ${entry.path}`);
    console.log(`   Storage: ${entry.storagePath}`);
  } catch (err) {
    console.error(`Failed to remove ${entry.name}:`, err);
    process.exit(1);
  }
};
