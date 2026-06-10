/**
 * Status Command
 *
 * Shows the indexing status of the current repository.
 */

import path from 'path';
import { findRepo, getStoragePaths, loadMeta, hasKuzuIndex } from '../storage/repo-manager.js';
import { getCurrentCommit, getCurrentBranch, isGitRepo, getGitRoot } from '../storage/git.js';
import { t } from './i18n/index.js';

export const statusCommand = async () => {
  const cwd = process.cwd();

  if (!isGitRepo(cwd)) {
    console.log(t('status.notGitRepo'));
    return;
  }

  const repo = await findRepo(cwd);
  if (!repo) {
    // Check if there's a stale KuzuDB index that needs migration
    const repoRoot = getGitRoot(cwd) ?? cwd;
    const { storagePath } = getStoragePaths(repoRoot);
    if (await hasKuzuIndex(storagePath)) {
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

  // Pick the index matching the checked-out branch (#2106). The flat index
  // belongs to the primary branch (repo.meta.branch); when the current branch
  // differs and has its own index, report that one. Legacy/no-branch metas and
  // detached HEAD fall through to the flat index (unchanged behavior).
  let activeMeta = repo.meta;
  let currentBranchIndexed = true;
  if (currentBranch && repo.meta.branch && currentBranch !== repo.meta.branch) {
    const { metaPath } = getStoragePaths(repo.repoPath, currentBranch);
    const branchMeta = await loadMeta(path.dirname(metaPath));
    if (branchMeta) activeMeta = branchMeta;
    else currentBranchIndexed = false;
  }

  console.log(`${t('status.repository')}: ${repo.repoPath}`);
  console.log(`${t('status.branch')}: ${currentBranch ?? t('status.detached')}`);

  if (!currentBranchIndexed) {
    console.log(
      `${t('status.status')}: ${t('status.branchNotIndexed', { primary: repo.meta.branch ?? '' })}`,
    );
    return;
  }

  const isUpToDate = currentCommit === activeMeta.lastCommit;
  console.log(`${t('status.indexed')}: ${new Date(activeMeta.indexedAt).toLocaleString()}`);
  console.log(`${t('status.indexedCommit')}: ${activeMeta.lastCommit?.slice(0, 7)}`);
  console.log(`${t('status.currentCommit')}: ${currentCommit?.slice(0, 7)}`);
  console.log(`${t('status.status')}: ${isUpToDate ? t('status.upToDate') : t('status.stale')}`);
};
