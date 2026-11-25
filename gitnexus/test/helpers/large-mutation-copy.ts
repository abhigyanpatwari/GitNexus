import assert from 'node:assert/strict';
import { MAX_INCREMENTAL_MUTATION_ROWS } from '../../src/core/incremental/compaction-policy.js';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';

const [repo, expectedFunctions] = process.argv.slice(2);
const options = { skipAgentsMd: true, skipSkills: true };
const logs: string[] = [];
const callbacks = { onProgress() {}, onLog: (message: string) => logs.push(message) };

try {
  const { incrementalStats } = await runFullAnalysis(repo, options, callbacks);
  if (expectedFunctions !== undefined) {
    assert.equal(incrementalStats?.changedFiles, 1, logs.join('\n'));
    assert.equal(incrementalStats.writeMode, 'full', logs.join('\n'));
    assert.ok(
      logs.some((line) => line.includes(`${MAX_INCREMENTAL_MUTATION_ROWS} graph rows`)),
      logs.join('\n'),
    );
    await initLbug(getStoragePaths(repo).lbugPath, { readOnly: true, skipFts: true });
    assert.deepEqual(
      await executeQuery(
        "MATCH (n:Function) WHERE n.filePath = 'src/generated.ts' RETURN count(n) AS count",
      ),
      [{ count: Number(expectedFunctions) }],
    );
  }
} finally {
  await closeLbug();
}
