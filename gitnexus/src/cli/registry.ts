/**
 * Registry Command (#3332)
 *
 * Exposes locked global-registry mutations for external tooling (git hooks,
 * cleanup scripts, CI) without exposing the internal registry-lock protocol.
 */

import path from 'node:path';
import type { Command } from 'commander';
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
import { requireDeletableStoragePath } from '../storage/storage-resolver.js';

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
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`No GitNexus index found for ${targetDir}; nothing to prune.`);
    }
    return result;
  }

  const [entries, storagePath] = await Promise.all([
    listRegisteredRepos(),
    requireDeletableStoragePath({
      path: repo.repoPath,
      storagePath: repo.storagePath,
    }),
  ]);
  const entry = findRegistryEntryByRepoPath(entries, repo.repoPath);

  const slots = await listStaleBranchSlots({
    repoPath: repo.repoPath,
    storagePath,
    branches: entry?.branches,
    includeSize: false,
  });

  const listingBlock = staleListingBlock(slots);
  if (listingBlock === 'heads-unavailable') {
    throw new Error(`Cannot list local git branches for ${repo.repoPath}.`);
  }
  if (listingBlock === 'listing-failed') {
    throw new Error(`Cannot inspect branch index directory under ${storagePath}.`);
  }

  const candidates = slots.filter(isDeleteCandidate);
  const probeFailed = slots
    .filter((slot) => slot.reason === 'probe-failed')
    .map((slot) => slot.branch);

  const pruned: string[] = [];
  const skippedLive: string[] = [];
  const failed: PruneBranchesFailure[] = [];

  if (dryRun) {
    for (const slot of candidates) {
      pruned.push(slot.branch);
    }
  } else {
    for (const slot of candidates) {
      const heads = listLocalHeads(repo.repoPath);
      if (heads === null) {
        throw new Error(`Cannot list local git branches for ${repo.repoPath} while pruning.`);
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
    registered: Boolean(entry),
    dryRun,
    pruned,
    skippedLive,
    failed,
    probeFailed,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (pruned.length === 0 && failed.length === 0 && probeFailed.length === 0) {
    console.log('No stale branch indexes found.');
  } else if (dryRun) {
    if (pruned.length > 0) {
      console.log(`Dry run: would prune ${pruned.length} branch index(es): ${pruned.join(', ')}`);
    }
    if (probeFailed.length > 0) {
      console.log(
        `Could not inspect ${probeFailed.length} branch slot(s): ${probeFailed.join(', ')}`,
      );
    }
  } else {
    if (pruned.length > 0) {
      console.log(`Pruned ${pruned.length} stale branch index(es): ${pruned.join(', ')}`);
    }
    if (skippedLive.length > 0) {
      console.log(`Skipped ${skippedLive.length} live branch(es): ${skippedLive.join(', ')}`);
    }
    if (probeFailed.length > 0) {
      console.log(
        `Could not inspect ${probeFailed.length} branch slot(s): ${probeFailed.join(', ')}`,
      );
    }
    if (failed.length > 0) {
      for (const item of failed) {
        logger.error({ branch: item.branch, error: item.error }, `Failed to prune ${item.branch}:`);
      }
    }
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }

  return result;
};

export function registerRegistryCommands(program: Command): void {
  const registry = program
    .command('registry')
    .description('Perform locked mutations on the global GitNexus registry');

  registry
    .command('prune-branches')
    .description(
      'Prune stale per-branch index slots and registry entries for deleted git branches under the global registry lock',
    )
    .option('-r, --repo <path>', 'Path to the git repository (default: current directory)', '.')
    .option('--dry-run', 'Report stale branches without deleting slots or modifying registry.json')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: PruneBranchesOptions) => {
      await pruneBranchesCommand(opts);
    });
}
