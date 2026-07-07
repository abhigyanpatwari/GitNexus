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
 */
export function parseShardArg(argv: string[]): string | undefined {
  return argv.find((a) => SHARD_RE.test(a));
}
