/**
 * Status Command
 * 
 * Shows the indexing status of the current repository.
 */

import { findRepo } from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo } from '../storage/git.js';
import { checkStaleness } from '../mcp/staleness.js';

export const statusCommand = async () => {
  const cwd = process.cwd();
  
  if (!isGitRepo(cwd)) {
    console.log('Not a git repository.');
    return;
  }

  const repo = await findRepo(cwd);
  if (!repo) {
    console.log('Repository not indexed.');
    console.log('Run: gitnexus analyze');
    return;
  }

  const currentCommit = getCurrentCommit(repo.repoPath);
  const staleness = checkStaleness(repo.repoPath, repo.meta.lastCommit ?? '', repo.meta.ignoreConfig || {});

  console.log(`Repository: ${repo.repoPath}`);
  console.log(`Indexed: ${new Date(repo.meta.indexedAt).toLocaleString()}`);
  console.log(`Indexed commit: ${repo.meta.lastCommit?.slice(0, 7)}`);
  console.log(`Current commit: ${currentCommit?.slice(0, 7)}`);
  if (staleness.isStale) {
    console.log('Status: ⚠️ stale (re-run gitnexus analyze)');
  } else if (staleness.ignoredOnlyChanges && currentCommit !== repo.meta.lastCommit) {
    console.log('Status: ✅ up-to-date (changes only in ignored paths)');
  } else {
    console.log('Status: ✅ up-to-date');
  }
};
