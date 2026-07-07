/**
 * Resolves the optional `--shard=<index>/<total>` argument for
 * `run-cross-platform.ts`.
 *
 * Extracted as a pure, side-effect-free function so the branch logic is
 * unit-testable without the script's top-level `execFileSync` (see
 * `test/unit/shard-arg.test.ts`). Mirrors the `computeSpawnPrefix` extraction
 * pattern in `test/helpers/cli-entry.ts`.
 */

const SHARD_RE = /^--shard=\d+\/\d+$/;

/**
 * Returns the matched `--shard=<index>/<total>` token (e.g. `--shard=1/3`) to
 * pass straight through to vitest, or `undefined` when no shard arg is present.
 *
 * Fails loud on a shard-shaped-but-malformed arg (e.g. `--shard=1`, `--shard`,
 * `--shard=abc`): a silently-ignored malformed arg would drop the shard flag and
 * run the full unsharded ~50-spawn suite, re-arming the Windows watchdog timeout
 * with no signal. Only `--shard` / `--shard=…` args are inspected, so unrelated
 * flags (including a hypothetical `--shardx=…`) pass through untouched.
 */
export function parseShardArg(argv: string[]): string | undefined {
  const shardArgs = argv.filter((a) => a === '--shard' || a.startsWith('--shard='));
  const malformed = shardArgs.find((a) => !SHARD_RE.test(a));
  if (malformed !== undefined) {
    throw new Error(`Malformed --shard arg '${malformed}' — expected --shard=<index>/<total>`);
  }
  return shardArgs[0];
}
