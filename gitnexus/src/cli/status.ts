/**
 * Status Command
 *
 * Shows the indexing status of the current repository.
 */

import path from 'path';
import {
  findRepo,
  getStoragePaths,
  loadMeta,
  hasKuzuIndex,
  readRegistry,
  resolveRegistryEntry,
  RegistryNotFoundError,
  RegistryAmbiguousTargetError,
} from '../storage/repo-manager.js';
import {
  getCurrentCommit,
  getCurrentBranch,
  isGitRepo,
  getGitRoot,
  isWorkingTreeDirty,
} from '../storage/git.js';
import {
  analyzerRunnerIdentitiesEqual,
  resolveAnalyzerRunnerIdentity,
} from '../core/analyzer-identity.js';
import { getIndexIncompleteReasons } from '../core/index-freshness.js';
import { detectIndexContentDrift, type IndexContentDrift } from '../core/index-content-drift.js';
import { t } from './i18n/index.js';

/** How many drifted paths the report names before summarizing the rest. */
const DRIFT_SAMPLE_LIMIT = 10;

/**
 * Machine-readable form of the per-file comparison. `'not-checked'` is its own
 * value rather than a silent omission: it says the index was already stale on
 * metadata alone, so the scan was skipped, which is not the same claim as a
 * scan that ran and found nothing.
 */
const describeContentDrift = (drift: IndexContentDrift | undefined) => {
  if (!drift) return { status: 'not-checked' as const };
  if (drift.kind === 'current') {
    return { status: 'current' as const, coveredFiles: drift.coveredFileCount };
  }
  if (drift.kind === 'unmeasurable') {
    return { status: 'unmeasurable' as const, reason: drift.reason };
  }
  return {
    status: 'drifted' as const,
    counts: {
      changed: drift.changed.length,
      added: drift.added.length,
      deleted: drift.deleted.length,
    },
    changed: drift.changed.slice(0, DRIFT_SAMPLE_LIMIT),
    added: drift.added.slice(0, DRIFT_SAMPLE_LIMIT),
    deleted: drift.deleted.slice(0, DRIFT_SAMPLE_LIMIT),
    truncated: {
      changed: drift.changed.length > DRIFT_SAMPLE_LIMIT,
      added: drift.added.length > DRIFT_SAMPLE_LIMIT,
      deleted: drift.deleted.length > DRIFT_SAMPLE_LIMIT,
    },
  };
};

/** Escape control characters in repo-relative paths before printing. */
const formatDriftPath = (rel: string): string =>
  /[\u0000-\u001f\u007f]/.test(rel) ? JSON.stringify(rel) : rel;
const printDriftDetail = (drift: Extract<IndexContentDrift, { kind: 'drifted' }>): void => {
  console.log(
    t('status.indexContentDrifted', {
      changed: drift.changed.length,
      added: drift.added.length,
      deleted: drift.deleted.length,
    }),
  );
  const labelled: [string, readonly string[]][] = [
    [t('status.driftChanged'), drift.changed],
    [t('status.driftAdded'), drift.added],
    [t('status.driftDeleted'), drift.deleted],
  ];
  for (const [label, paths] of labelled) {
    for (const p of paths.slice(0, DRIFT_SAMPLE_LIMIT)) {
      console.log(`  ${label}: ${formatDriftPath(p)}`);
    }
    const remaining = paths.length - DRIFT_SAMPLE_LIMIT;
    if (remaining > 0) console.log(t('status.indexContentMore', { count: remaining, label }));
  }
};

export interface StatusOptions {
  json?: boolean;
  /** Resolve a registered index without requiring its original checkout to remain on disk. */
  repo?: string;
}

export const statusCommand = async (options: StatusOptions = {}) => {
  if (options.repo) {
    let entry;
    try {
      entry = resolveRegistryEntry(await readRegistry(), options.repo);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (options.json) {
        console.log(
          JSON.stringify({ schemaVersion: 1, repository: options.repo, error: 'not-indexed' }),
        );
      } else if (
        err instanceof RegistryNotFoundError ||
        err instanceof RegistryAmbiguousTargetError
      ) {
        console.log(error);
      } else {
        throw err;
      }
      return;
    }

    const meta = await loadMeta(entry.storagePath);
    if (!meta) {
      if (options.json) {
        console.log(
          JSON.stringify({
            schemaVersion: 1,
            repository: entry.path,
            storagePath: entry.storagePath,
            error: 'not-indexed',
          }),
        );
      } else {
        console.log(`No readable index metadata at ${entry.storagePath}`);
      }
      return;
    }

    const currentRunnerIdentity = resolveAnalyzerRunnerIdentity(import.meta.url);
    const runnerIdentityIsCurrent = analyzerRunnerIdentitiesEqual(
      meta.runnerIdentity,
      currentRunnerIdentity,
    );
    const incompleteReasons = getIndexIncompleteReasons(meta);
    const sourceAvailable = isGitRepo(entry.path);
    const payload = {
      schemaVersion: 1,
      repository: entry.path,
      storagePath: entry.storagePath,
      sourceAvailable,
      index: {
        indexedAt: meta.indexedAt,
        commit: meta.lastCommit,
        runnerIdentity: meta.runnerIdentity ?? null,
        runnerIdentityStatus: runnerIdentityIsCurrent ? 'current' : 'stale-or-unknown',
        incompleteReasons,
        contentRetention: meta.contentRetention ?? 'full',
      },
      current: sourceAvailable ? { commit: getCurrentCommit(entry.path) } : null,
      // Without a checkout GitNexus can prove the index is readable, but cannot
      // certify that it is current relative to source. Keep that distinction in
      // the machine-readable status instead of reporting a false all-clear.
      status: sourceAvailable ? 'registered' : 'source-unavailable',
    };
    if (options.json) {
      console.log(JSON.stringify(payload));
    } else {
      console.log(`Repository: ${entry.path}`);
      console.log(`Index storage: ${entry.storagePath}`);
      console.log(`Indexed: ${new Date(meta.indexedAt).toLocaleString()}`);
      console.log(`Indexed commit: ${meta.lastCommit?.slice(0, 7)}`);
      console.log(
        sourceAvailable
          ? 'Status: registered index (use status without --repo for working-tree freshness)'
          : 'Status: source checkout unavailable; graph index remains queryable through the registry',
      );
    }
    return;
  }

  const cwd = process.cwd();

  if (!isGitRepo(cwd)) {
    if (options.json) {
      console.log(JSON.stringify({ schemaVersion: 1, error: 'not-git-repository' }));
      return;
    }
    console.log(t('status.notGitRepo'));
    return;
  }

  const repo = await findRepo(cwd);
  if (!repo) {
    // Check if there's a stale KuzuDB index that needs migration
    const repoRoot = getGitRoot(cwd) ?? cwd;
    const { storagePath } = getStoragePaths(repoRoot);
    const staleKuzu = await hasKuzuIndex(storagePath);
    if (options.json) {
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          repository: repoRoot,
          error: staleKuzu ? 'stale-kuzu-index' : 'not-indexed',
        }),
      );
      return;
    }
    if (staleKuzu) {
      console.log(t('status.staleKuzu'));
      console.log(t('status.rebuildLadybug'));
    } else {
      console.log(t('status.repoNotIndexed'));
      console.log(t('common.runAnalyzeShort'));
    }
    return;
  }

  const currentCommit = getCurrentCommit(repo.repoPath);
  const currentBranch = getCurrentBranch(repo.repoPath);

  // Pick the index matching the checked-out branch (#2106/#2354). A pinned
  // `--branch` sub-index for the current branch wins; otherwise report the
  // flat workspace index, which follows the checked-out working tree — the
  // commit comparison below then says whether it needs a re-analyze. Legacy/
  // no-branch metas and detached HEAD also fall through to the flat index.
  let activeMeta = repo.meta;
  let workspaceLagsBranch = false;
  if (currentBranch && repo.meta.branch && currentBranch !== repo.meta.branch) {
    const { metaPath } = getStoragePaths(repo.repoPath, currentBranch);
    const branchMeta = await loadMeta(path.dirname(metaPath));
    if (branchMeta) activeMeta = branchMeta;
    else workspaceLagsBranch = true;
  }

  const currentRunnerIdentity = resolveAnalyzerRunnerIdentity(import.meta.url);
  const runnerIdentityIsCurrent = analyzerRunnerIdentitiesEqual(
    activeMeta.runnerIdentity,
    currentRunnerIdentity,
  );
  const incompleteReasons = getIndexIncompleteReasons(activeMeta);
  const metadataIsCurrent =
    currentCommit === activeMeta.lastCommit &&
    runnerIdentityIsCurrent &&
    incompleteReasons.length === 0;

  // A matching HEAD is not enough: `analyze` re-indexes changed content at the
  // same commit, so the files the index covers must still be compared against
  // disk. Only worth the scan once the cheap metadata checks agree, and skipped
  // for non-git folders (currentCommit === '') to match analyze.
  const contentDrift: IndexContentDrift | undefined =
    metadataIsCurrent && currentCommit !== ''
      ? await detectIndexContentDrift(
          repo.repoPath,
          activeMeta.fileHashes,
          activeMeta.indexCoverage,
        )
      : undefined;

  // The repo-wide dirty flag survives only as the fallback for metadata written
  // before `fileHashes` existed. Where the per-file comparison can run it
  // decides, so a file the index does not cover no longer pins a byte-current
  // index to a "stale" verdict that `analyze` is powerless to clear (#3077).
  const contentIsCurrent =
    contentDrift === undefined ||
    contentDrift.kind === 'current' ||
    (contentDrift.kind === 'unmeasurable' &&
      contentDrift.reason === 'no-file-hashes' &&
      !isWorkingTreeDirty(repo.repoPath));

  const isUpToDate = metadataIsCurrent && contentIsCurrent;
  if (options.json) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        repository: repo.repoPath,
        branch: currentBranch,
        workspaceIndexBranch: workspaceLagsBranch ? (repo.meta.branch ?? null) : null,
        index: {
          indexedAt: activeMeta.indexedAt,
          commit: activeMeta.lastCommit,
          runnerIdentity: activeMeta.runnerIdentity ?? null,
          runnerIdentityStatus: runnerIdentityIsCurrent ? 'current' : 'stale-or-unknown',
          incompleteReasons,
        },
        current: {
          commit: currentCommit,
          runnerIdentity: currentRunnerIdentity,
        },
        contentDrift: describeContentDrift(contentDrift),
        status: isUpToDate ? 'up-to-date' : 'stale',
      }),
    );
    return;
  }

  console.log(`${t('status.repository')}: ${repo.repoPath}`);
  console.log(`${t('status.branch')}: ${currentBranch ?? t('status.detached')}`);

  if (workspaceLagsBranch) {
    console.log(t('status.workspaceIndexLabel', { primary: repo.meta.branch ?? '' }));
  }

  console.log(`${t('status.indexed')}: ${new Date(activeMeta.indexedAt).toLocaleString()}`);
  console.log(`${t('status.indexedCommit')}: ${activeMeta.lastCommit?.slice(0, 7)}`);
  console.log(`${t('status.currentCommit')}: ${currentCommit?.slice(0, 7)}`);
  // Emit the complete, versioned receipt as JSON so humans can inspect it and
  // automation can compare it without reverse-engineering a display string.
  // `null` is the backward-compatible signal for pre-receipt metadata.
  console.log(
    `${t('status.indexRunnerIdentity')}: ${JSON.stringify(activeMeta.runnerIdentity ?? null)}`,
  );
  if (incompleteReasons.length > 0) {
    console.log(`Index incomplete reasons: ${JSON.stringify(incompleteReasons)}`);
  }
  console.log(`${t('status.currentRunnerIdentity')}: ${JSON.stringify(currentRunnerIdentity)}`);
  if (contentDrift?.kind === 'current') {
    console.log(t('status.indexContentCurrent', { count: contentDrift.coveredFileCount }));
  } else if (contentDrift?.kind === 'drifted') {
    printDriftDetail(contentDrift);
  } else if (contentDrift?.kind === 'unmeasurable') {
    if (contentDrift.reason === 'scan-failed') {
      console.log(t('status.indexContentScanFailed'));
    } else if (!isUpToDate) {
      console.log(t('status.indexContentUnmeasurable', { reason: contentDrift.reason }));
    }
  }
  console.log(`${t('status.status')}: ${isUpToDate ? t('status.upToDate') : t('status.stale')}`);
};
