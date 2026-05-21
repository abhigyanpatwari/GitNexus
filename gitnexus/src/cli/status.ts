/**
 * Status Command
 *
 * Shows the indexing status of the current repository.
 */

import { findRepo, getStoragePaths, hasKuzuIndex } from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo, getGitRoot } from '../storage/git.js';
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
  const isUpToDate = currentCommit === repo.meta.lastCommit;

  console.log(`${t('status.repository')}: ${repo.repoPath}`);
  console.log(`${t('status.indexed')}: ${new Date(repo.meta.indexedAt).toLocaleString()}`);
  console.log(`${t('status.indexedCommit')}: ${repo.meta.lastCommit?.slice(0, 7)}`);
  console.log(`${t('status.currentCommit')}: ${currentCommit?.slice(0, 7)}`);
  console.log(`${t('status.status')}: ${isUpToDate ? t('status.upToDate') : t('status.stale')}`);
};
