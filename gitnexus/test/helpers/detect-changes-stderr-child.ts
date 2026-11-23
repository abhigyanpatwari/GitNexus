/**
 * Child process for #3837.
 *
 * Spawned as `node --import <tsx> --import detect-changes-stderr-hooks.mjs
 * detect-changes-stderr-child.ts <scope> [base_ref]`, with DETECT_CHANGES_REPO
 * pointing at a temp git checkout. Prints the `detect_changes` payload as
 * JSON on stdout. Git's own stderr is left on this process's stderr so the
 * parent can assert it does not leak.
 */
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const repo = process.env.DETECT_CHANGES_REPO;
const scope = process.argv[2];
const baseRef = process.argv[3];

if (!repo || !scope) {
  process.stderr.write('usage: detect-changes-stderr-child.ts <scope> [base_ref]\n');
  process.exit(2);
}

const backend = new LocalBackend();
try {
  const ready = await backend.init();
  if (!ready) {
    throw new Error('LocalBackend.init found no repository');
  }
  const result = await backend.callTool('detect_changes', {
    scope,
    repo: 'autocrlf-repo',
    ...(baseRef ? { base_ref: baseRef } : {}),
  });
  process.stdout.write(JSON.stringify(result));
} catch (err) {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stdout.write(JSON.stringify({ crashed: true, message }));
  process.exitCode = 1;
} finally {
  await backend.dispose();
}
