/**
 * Registry Prune-Branches Implementation (#3332)
 *
 * Performs locked global-registry branch pruning for external tooling (git
 * hooks, cleanup scripts, CI) without exposing the internal registry-lock
 * protocol.
 */

import path from 'node:path';
import { logger } from '../core/logger.js';
import { listLocalHeads } from '../storage/git.js';
import {
  findRegistryEntryByRepoPath,
  findRepo,
  listRegisteredRepos,
} from '../storage/repo-manager.js';
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
  failed: PruneBranchesFailure[];
  probeFailed: string[];
  incomplete?: boolean;
  error?: string;
}

function emitResult(result: PruneBranchesResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (
    !result.registered &&
    !result.error &&
    result.pruned.length === 0 &&
    result.failed.length === 0
  ) {
    console.log(`No GitNexus index found for ${result.repoPath}; nothing to prune.`);
    return;
  }

  if (
    !result.error &&
    result.pruned.length === 0 &&
    result.skippedLive.length === 0 &&
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

  const repo = await findRepo(targetDir);
  if (!repo) {
    const result: PruneBranchesResult = {
      repoPath: targetDir,
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

  let entries: Awaited<ReturnType<typeof listRegisteredRepos>>;
  let storagePath: string;
  try {
    [entries, storagePath] = await Promise.all([
      listRegisteredRepos(),
      requireDeletableStoragePath({
        path: repo.repoPath,
        storagePath: repo.storagePath,
      }),
    ]);
  } catch (err) {
    const message =
      err instanceof StorageDeletionError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    const result: PruneBranchesResult = {
      repoPath: repo.repoPath,
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

  const entry = findRegistryEntryByRepoPath(entries, repo.repoPath);
  const registered = Boolean(entry);

  const slots = await listStaleBranchSlots({
    repoPath: repo.repoPath,
    storagePath,
    branches: entry?.branches,
    includeSize: false,
  });

  const listingBlock = staleListingBlock(slots);
  if (listingBlock === 'heads-unavailable' || listingBlock === 'listing-failed') {
    const result: PruneBranchesResult = {
      repoPath: repo.repoPath,
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
  const failed: PruneBranchesFailure[] = [];
  let incomplete = false;
  let error: string | undefined;

  if (dryRun) {
    for (const slot of candidates) {
      pruned.push(slot.branch);
    }
  } else {
    for (const slot of candidates) {
      const heads = listLocalHeads(repo.repoPath, { scrubLocalEnv: true });
      if (heads === null) {
        incomplete = true;
        error = 'heads-unavailable';
        break;
      }
      if (heads.includes(slot.branch)) {
        skippedLive.push(slot.branch);
        continue;
      }
      const removed = await removeBranchSlot({
        repoPath: repo.repoPath,
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
    repoPath: repo.repoPath,
    registered,
    dryRun,
    pruned,
    skippedLive,
    failed,
    probeFailed,
    ...(incomplete ? { incomplete: true } : {}),
    ...(error !== undefined ? { error } : {}),
  };

  emitResult(result, asJson);

  if (failed.length > 0 || incomplete) {
    process.exitCode = 1;
  }

  return result;
};
