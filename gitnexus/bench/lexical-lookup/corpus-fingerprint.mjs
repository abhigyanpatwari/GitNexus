import { createHash } from 'node:crypto';
import { runBenchmarkTool } from '../lib/benchmark-tools.mjs';

// Cone-mode sparse checkouts include files in the ancestors of the requested
// directories. Hash each materialized stage-zero path, mode and blob ID.
export function checkoutFingerprint(repo) {
  const entries = runBenchmarkTool('git', ['ls-files', '--stage', '-t', '--sparse', '-z'], {
    cwd: repo,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!Buffer.isBuffer(entries)) throw new TypeError('git ls-files must return raw bytes');
  const hash = createHash('sha256');
  for (let start = 0; start < entries.length; ) {
    const end = entries.indexOf(0, start);
    if (end === -1) throw new Error('Incomplete git ls-files record');
    // H marks a cached, materialized entry and S marks skip-worktree. Keeping
    // the terminating NUL preserves arbitrary path bytes without decoding.
    if (entries[start] === 0x48) hash.update(entries.subarray(start + 2, end + 1));
    start = end + 1;
  }
  return 'checkout-sha256:' + hash.digest('hex');
}
