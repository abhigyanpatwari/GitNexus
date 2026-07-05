/**
 * List Command
 *
 * Shows all indexed repositories from the global registry.
 */

import { listRegisteredRepos } from '../storage/repo-manager.js';
import { t } from './i18n/index.js';

export const listCommand = async () => {
  const entries = await listRegisteredRepos({ validate: true });

  if (entries.length === 0) {
    console.log(t('common.notIndexed'));
    console.log(t('common.runAnalyze'));
    return;
  }

  console.log(`\n  ${t('list.title', { count: entries.length })}\n`);

  // Count occurrences of each name so colliding entries can be
  // disambiguated in the header (#829). Unique-name entries render
  // identically to pre-#829 output; only collisions gain a suffix.
  const nameCounts = new Map<string, number>();
  for (const e of entries) {
    const key = e.name.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  for (const entry of entries) {
    const indexedDate = new Date(entry.indexedAt).toLocaleString();
    const stats = entry.stats || {};
    const commitShort = entry.lastCommit?.slice(0, 7) || t('list.unknown');
    const hasCollision = (nameCounts.get(entry.name.toLowerCase()) ?? 0) > 1;
    const header = hasCollision ? `${entry.name}  (${entry.path})` : entry.name;

    console.log(`  ${header}`);
    console.log(`    ${t('common.path')}:    ${entry.path}`);
    console.log(`    ${t('list.indexed')}: ${indexedDate}`);
    console.log(`    ${t('list.commit')}:  ${commitShort}`);
    if (entry.branch) console.log(`    ${t('list.branch')}:  ${entry.branch}`);
    console.log(
      `    ${t('list.stats')}:   ${t('list.statsValue', {
        files: stats.files ?? 0,
        symbols: stats.nodes ?? 0,
        edges: stats.edges ?? 0,
      })}`,
    );
    if (stats.communities) console.log(`    ${t('list.clusters')}:   ${stats.communities}`);
    if (stats.processes) console.log(`    ${t('list.processes')}:  ${stats.processes}`);
    // Per-branch indexes (#2106). Only rendered when extra branches were
    // indexed for this path, so single-branch output is unchanged.
    if (entry.branches && entry.branches.length > 0) {
      console.log(`    ${t('list.branchIndexes')}:`);
      for (const b of entry.branches) {
        const bCommit = b.lastCommit?.slice(0, 7) || t('list.unknown');
        const bIndexed = new Date(b.indexedAt).toLocaleString();
        console.log(
          `      ${t('list.branchLine', { branch: b.branch, commit: bCommit, indexed: bIndexed })}`,
        );
      }
    }
    console.log('');
  }
};
