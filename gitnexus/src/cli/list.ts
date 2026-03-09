/**
 * List Command
 * 
 * Shows all indexed repositories from the global registry.
 */

import { listRegisteredRepos } from '../storage/repo-manager.js';

interface ListOptions {
  json?: boolean;
  sort?: 'name' | 'indexed' | 'files' | 'symbols';
  filter?: string;
}

export const listCommand = async (options: ListOptions = {}) => {
  const { json = false, sort = 'indexed', filter } = options;
  let entries = await listRegisteredRepos({ validate: true });

  // Filter by name if specified
  if (filter) {
    entries = entries.filter(entry => 
      entry.name.toLowerCase().includes(filter.toLowerCase()) ||
      entry.path.toLowerCase().includes(filter.toLowerCase())
    );
  }

  // Sort entries
  entries.sort((a, b) => {
    switch (sort) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'files':
        return (b.stats?.files ?? 0) - (a.stats?.files ?? 0);
      case 'symbols':
        return (b.stats?.nodes ?? 0) - (a.stats?.nodes ?? 0);
      case 'indexed':
      default:
        return new Date(b.indexedAt).getTime() - new Date(a.indexedAt).getTime();
    }
  });

  if (entries.length === 0) {
    if (json) {
      console.log(JSON.stringify({ repositories: [], total: 0 }));
    } else {
      console.log('No indexed repositories found.');
      console.log('Run `gitnexus analyze` in a git repo to index it.');
    }
    return;
  }

  if (json) {
    // Output JSON format for script-friendly output
    const output = {
      repositories: entries.map(entry => ({
        name: entry.name,
        path: entry.path,
        indexedAt: entry.indexedAt,
        lastCommit: entry.lastCommit,
        stats: {
          files: entry.stats?.files ?? 0,
          nodes: entry.stats?.nodes ?? 0,
          edges: entry.stats?.edges ?? 0,
          communities: entry.stats?.communities ?? 0,
          processes: entry.stats?.processes ?? 0,
        }
      })),
      total: entries.length
    };
    console.log(JSON.stringify(output, null, 2));
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
    console.log(`    Stats:   ${stats.files ?? 0} files, ${stats.nodes ?? 0} symbols, ${stats.edges ?? 0} edges`);
    if (stats.communities) console.log(`    Clusters:   ${stats.communities}`);
    if (stats.processes) console.log(`    Processes:  ${stats.processes}`);
    console.log('');
  }
};
