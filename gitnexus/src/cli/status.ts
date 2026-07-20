/**
 * Status Command
 *
 * Shows the indexing status of the current repository.
 */

import path from 'path';
import { findRepo, getStoragePaths, loadMeta, hasKuzuIndex } from '../storage/repo-manager.js';
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
import { t } from './i18n/index.js';

export interface StatusOptions {
  json?: boolean;
}

export const statusCommand = async (options: StatusOptions = {}) => {
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
  // A matching HEAD is not enough: `analyze` re-indexes a dirty working tree,
  // so a repo with uncommitted source changes is stale even at the same commit.
  // Skip the check for non-git folders (currentCommit === '') to match analyze.
  const isUpToDate =
    currentCommit === activeMeta.lastCommit &&
    runnerIdentityIsCurrent &&
    incompleteReasons.length === 0 &&
    (currentCommit === '' || !isWorkingTreeDirty(repo.repoPath));
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
  console.log(`${t('status.status')}: ${isUpToDate ? t('status.upToDate') : t('status.stale')}`);
};
