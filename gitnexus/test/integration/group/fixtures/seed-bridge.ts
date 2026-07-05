/**
 * Cross-process bridge seeder for `bridge-cache-reopen.test.ts`.
 *
 * Writes a valid `bridge.lbug` into `argv[2]` and exits. Running this as a
 * SEPARATE process is the whole point: the writable handle is fully released by
 * process death before the parent test opens read-only, so the test's first RO
 * open is a clean cross-process open — NOT the in-process write→read reopen that
 * still fails on Windows. That is what lets the cache's read→read REUSE
 * assertion actually run on win32 instead of being skipped.
 *
 * Invoked as: node --import <tsx-loader> seed-bridge.ts <groupDir>
 */
import { writeBridge } from '../../../../src/core/group/bridge-db.js';
import { makeContract } from '../../../unit/group/fixtures.js';

async function main(): Promise<void> {
  const groupDir = process.argv[2];
  if (!groupDir) {
    process.stderr.write('usage: seed-bridge.ts <groupDir>\n');
    process.exit(2);
  }
  await writeBridge(groupDir, {
    contracts: [makeContract()],
    crossLinks: [],
    repoSnapshots: {},
    missingRepos: [],
  });
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(
      `seed-bridge failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  },
);
