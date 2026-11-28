/**
 * Registry Prune-Branches Implementation (#3332)
 *
 * Performs locked global-registry branch pruning for external tooling (git
 * hooks, cleanup scripts, CI) without exposing the internal registry-lock
 * protocol.
 */

import path from 'node:path';
import { logger } from '../core/logger.js';
import { getGitRoot, listLocalHeads } from '../storage/git.js';
import { acquireIndexLock } from '../storage/index-lock.js';
import {
  canonicalizePath,
  findRegistryEntryByRepoPath,
  loadRepo,
  readRegistryStrictIfPresent,
  registryPathEquals,
  type RegistryEntry,
} from '../storage/repo-manager.js';
import { loadMeta } from '../storage/repo-meta.js';
import {
  isDeleteCandidate,
  listStaleBranchSlots,
  removeBranchSlot,
  staleListingBlock,
} from '../storage/stale-branch-slots.js';
import { requireDeletableStoragePath, StorageDeletionError } from '../storage/storage-resolver.js';

export interface PruneBranchesOptions {
  repo?: string;
  dryRun?: boolean;
  json?: boolean;
}

export interface PruneBranchesFailure {
  branch: string;
  error: string;
}

export interface PruneBranchesResult {
  repoPath: string;
  registered: boolean;
  dryRun: boolean;
  pruned: string[];
  skippedLive: string[];
  skippedBusy?: string[];
  failed: PruneBranchesFailure[];
  probeFailed: string[];
  incomplete?: boolean;
  error?: string;
}

const isSlotBusy = async (slotDir: string): Promise<boolean> => {
  let lock: Awaited<ReturnType<typeof acquireIndexLock>> | undefined;
  try {
    lock = await acquireIndexLock(slotDir, { timeoutMs: 1, sweep: false });
    return lock.lockFree;
  } catch {
    return true;
  } finally {
    lock?.release();
  }
};

function emitResult(result: PruneBranchesResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const busyCount = result.skippedBusy?.length ?? 0;

  if (
    !result.registered &&
    !result.error &&
    result.pruned.length === 0 &&
    result.skippedLive.length === 0 &&
    busyCount === 0 &&
    result.failed.length === 0 &&
    result.probeFailed.length === 0
  ) {
    console.log(`No GitNexus index found for ${result.repoPath}; nothing to prune.`);
    return;
  }

  if (
    !result.error &&
    result.pruned.length === 0 &&
    result.skippedLive.length === 0 &&
    busyCount === 0 &&
    result.failed.length === 0 &&
    result.probeFailed.length === 0
  ) {
    console.log('No stale branch indexes found.');
    return;
  }

  if (result.dryRun) {
    if (result.pruned.length > 0) {
      console.log(
        `Dry run: would prune ${result.pruned.length} branch index(es): ${result.pruned.join(', ')}`,
      );
    }
    if (result.probeFailed.length > 0) {
      console.log(
        `Could not inspect ${result.probeFailed.length} branch slot(s): ${result.probeFailed.join(', ')}`,
      );
    }
    if (result.error) {
      logger.error(result.error);
    }
    return;
  }

  if (result.pruned.length > 0) {
    console.log(
      `Pruned ${result.pruned.length} stale branch index(es): ${result.pruned.join(', ')}`,
    );
  }
  if (result.skippedLive.length > 0) {
    console.log(
      `Skipped ${result.skippedLive.length} live branch(es): ${result.skippedLive.join(', ')}`,
    );
  }
  if (result.skippedBusy && result.skippedBusy.length > 0) {
    console.log(
      `Skipped ${result.skippedBusy.length} busy branch slot(s): ${result.skippedBusy.join(', ')}`,
    );
  }
  if (result.probeFailed.length > 0) {
    console.log(
      `Could not inspect ${result.probeFailed.length} branch slot(s): ${result.probeFailed.join(', ')}`,
    );
  }
  for (const item of result.failed) {
    logger.error({ branch: item.branch, error: item.error }, `Failed to prune ${item.branch}:`);
  }
  if (result.error) {
    logger.error(result.error);
  }
}

export const pruneBranchesCommand = async (
  options?: PruneBranchesOptions,
): Promise<PruneBranchesResult> => {
  const targetDir = path.resolve(options?.repo ?? '.');
  const dryRun = Boolean(options?.dryRun);
  const asJson = Boolean(options?.json);

  // Fail closed when registry.json exists but is corrupt or unreadable so it
  // is never treated as an empty successful prune.
  let strictEntries: RegistryEntry[] | undefined;
  try {
    strictEntries = await readRegistryStrictIfPresent();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: PruneBranchesResult = {
      repoPath: targetDir,
      registered: false,
      dryRun,
      pruned: [],
      skippedLive: [],
      failed: [],
      probeFailed: [],
      incomplete: true,
      error: message,
    };
    emitResult(result, asJson);
    process.exitCode = 1;
    return result;
  }

  const checkoutRoot = getGitRoot(targetDir, { scrubLocalEnv: true }) ?? targetDir;
  const entry = findRegistryEntryByRepoPath(strictEntries ?? [], checkoutRoot);
  const repo = await loadRepo(checkoutRoot);

  const ownerTarget = entry
    ? { path: entry.path, storagePath: entry.storagePath }
    : repo
      ? { path: repo.repoPath, storagePath: repo.storagePath }
      : null;

  if (!ownerTarget) {
    const result: PruneBranchesResult = {
      repoPath: checkoutRoot,
      registered: false,
      dryRun,
      pruned: [],
      skippedLive: [],
      failed: [],
      probeFailed: [],
    };
    emitResult(result, asJson);
    return result;
  }

  // Validate checkout and registered storage identity before any deletion.
  if (entry && repo) {
    const sameRepo = registryPathEquals(
      canonicalizePath(entry.path),
      canonicalizePath(repo.repoPath),
    );
    const sameStorage = registryPathEquals(
      canonicalizePath(entry.storagePath),
      canonicalizePath(repo.storagePath),
    );
    if (!sameRepo || !sameStorage) {
      const result: PruneBranchesResult = {
        repoPath: checkoutRoot,
        registered: true,
        dryRun,
        pruned: [],
        skippedLive: [],
        failed: [],
        probeFailed: [],
        incomplete: true,
        error: `Storage identity mismatch between checkout (${repo.storagePath}) and registry (${entry.storagePath}).`,
      };
      emitResult(result, asJson);
      process.exitCode = 1;
      return result;
    }
  }

  const resolvedRepoPath = repo?.repoPath ?? ownerTarget.path;
  const rawStoragePath = repo?.storagePath ?? ownerTarget.storagePath;
  const registered = Boolean(entry);

  let storagePath: string;
  try {
    storagePath = await requireDeletableStoragePath({
      path: resolvedRepoPath,
      storagePath: rawStoragePath,
    });
  } catch (err) {
    const message =
      err instanceof StorageDeletionError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    const result: PruneBranchesResult = {
      repoPath: resolvedRepoPath,
      registered,
      dryRun,
      pruned: [],
      skippedLive: [],
      failed: [],
      probeFailed: [],
      incomplete: true,
      error: message,
    };
    emitResult(result, asJson);
    process.exitCode = 1;
    return result;
  }

  const storageMeta = await loadMeta(storagePath);
  if (
    storageMeta?.repoPath &&
    !registryPathEquals(canonicalizePath(storageMeta.repoPath), canonicalizePath(resolvedRepoPath))
  ) {
    const result: PruneBranchesResult = {
      repoPath: resolvedRepoPath,
      registered,
      dryRun,
      pruned: [],
      skippedLive: [],
      failed: [],
      probeFailed: [],
      incomplete: true,
      error: `Storage metadata repoPath (${storageMeta.repoPath}) does not match checkout (${resolvedRepoPath}).`,
    };
    emitResult(result, asJson);
    process.exitCode = 1;
    return result;
  }

  const slots = await listStaleBranchSlots({
    repoPath: resolvedRepoPath,
    storagePath,
    branches: entry?.branches,
    includeSize: false,
  });

  const listingBlock = staleListingBlock(slots);
  if (listingBlock === 'heads-unavailable' || listingBlock === 'listing-failed') {
    const result: PruneBranchesResult = {
      repoPath: resolvedRepoPath,
      registered,
      dryRun,
      pruned: [],
      skippedLive: [],
      failed: [],
      probeFailed: [],
      incomplete: true,
      error: listingBlock,
    };
    emitResult(result, asJson);
    process.exitCode = 1;
    return result;
  }

  const candidates = slots.filter(isDeleteCandidate);
  const probeFailed = slots
    .filter((slot) => slot.reason === 'probe-failed')
    .map((slot) => slot.branch);

  const pruned: string[] = [];
  const skippedLive: string[] = [];
  const skippedBusy: string[] = [];
  const failed: PruneBranchesFailure[] = [];
  let incomplete = false;
  let error: string | undefined;

  if (dryRun) {
    for (const slot of candidates) {
      pruned.push(slot.branch);
    }
  } else {
    for (const slot of candidates) {
      const heads = listLocalHeads(resolvedRepoPath, { scrubLocalEnv: true });
      if (heads === null) {
        incomplete = true;
        error = 'heads-unavailable';
        break;
      }
      if (heads.includes(slot.branch)) {
        skippedLive.push(slot.branch);
        continue;
      }
      if (slot.dir !== null && (await isSlotBusy(slot.dir))) {
        skippedBusy.push(slot.branch);
        continue;
      }
      const removed = await removeBranchSlot({
        repoPath: resolvedRepoPath,
        storagePath,
        branch: slot.branch,
        dir: slot.dir,
      });
      if (!removed.ok) {
        failed.push({
          branch: slot.branch,
          error: removed.error?.message ?? 'Unknown error removing branch slot',
        });
        continue;
      }
      pruned.push(slot.branch);
    }
  }

  const result: PruneBranchesResult = {
    repoPath: resolvedRepoPath,
    registered,
    dryRun,
    pruned,
    skippedLive,
    ...(skippedBusy.length > 0 ? { skippedBusy } : {}),
    failed,
    probeFailed,
    ...(incomplete ? { incomplete: true } : {}),
    ...(error !== undefined ? { error } : {}),
  };

  emitResult(result, asJson);

  if (failed.length > 0 || incomplete || probeFailed.length > 0 || skippedBusy.length > 0) {
    process.exitCode = 1;
  }

  return result;
};
