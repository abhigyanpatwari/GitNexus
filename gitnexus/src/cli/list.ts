/**
 * List Command
 *
 * Shows all indexed repositories from the global registry.
 */

import { listRegisteredRepos } from '../storage/repo-manager.js';

export const listCommand = async () => {
  const entries = await listRegisteredRepos({ validate: true });

  if (entries.length === 0) {
    console.log('No indexed repositories found.');
    console.log('Run `gitnexus analyze` in a git repo to index it.');
    return;
  }

  console.log(`\n  Indexed Repositories (${entries.length})\n`);

  for (const entry of entries) {
    const indexedDate = new Date(entry.indexedAt).toLocaleString();
    const stats = entry.stats || {};
    const commitShort = entry.lastCommit?.slice(0, 7) || 'unknown';

    console.log(`  ${entry.name}`);
    console.log(`    Path:    ${entry.path}`);
    console.log(`    Indexed: ${indexedDate}`);
    console.log(`    Commit:  ${commitShort}`);
    console.log(
      `    Stats:   ${stats.files ?? 0} files, ${stats.nodes ?? 0} symbols, ${stats.edges ?? 0} edges`,
    );
    if (stats.communities) console.log(`    Clusters:   ${stats.communities}`);
    if (stats.processes) console.log(`    Processes:  ${stats.processes}`);
    console.log('');
  }
};
