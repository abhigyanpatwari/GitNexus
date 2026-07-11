/**
 * How e2e tests launch the gitnexus CLI as a subprocess.
 *
 * Default — `node --import tsx src/cli/index.ts`: always reflects current source,
 * so any local run (built or not) exercises your edits.
 *
 * CI opts into the built CLI by setting `GITNEXUS_E2E_CLI=dist` AFTER its build
 * step (see `.github/workflows/ci-tests.yml`) — `node dist/cli/index.js`, which
 * skips the per-spawn tsx transpile of the whole CLI source graph. The
 * platform-sensitive suite spawns the CLI ~50 times and Windows is ~5× slower at
 * process startup, so that transpile dominated the job and tripped its watchdog.
 *
 * We deliberately do NOT infer dist from a generic `CI` env var: CI-presence does
 * not prove `dist/` is fresh, and an ambient `CI=1` (agent sandboxes, other tools)
 * could otherwise silently spawn a STALE build. dist is used only when explicitly
 * requested, so the entry point in effect is always knowable from the environment.
 *
 * Bonus: the CLI's `ensureHeap()` re-exec "just works" from dist; under tsx it drops
 * the `--import` loader, which is why analyze-calling tests pre-set
 * `--max-old-space-size` in their `cliEnv()`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// test/helpers/cli-entry.ts → repo root is two levels up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
const srcEntry = path.join(repoRoot, 'src', 'cli', 'index.ts');

/**
 * Pure resolver, exported for unit testing. `mode` is the raw `GITNEXUS_E2E_CLI`
 * value: `'dist'` selects the built CLI (and requires it to exist); unset / `''` /
 * `'src'` select tsx-on-source; any other value throws (a typo shouldn't silently
 * degrade to tsx). Kept side-effect-free so the branch logic can be locked
 * without env/filesystem gymnastics.
 */
export function computeSpawnPrefix(opts: {
  mode: string | undefined;
  distEntry: string;
  srcEntry: string;
  distExists: boolean;
  tsxLoaderUrl: string;
}): string[] {
  if (opts.mode === 'dist') {
    if (!opts.distExists) {
      throw new Error(
        `GITNEXUS_E2E_CLI=dist but ${opts.distEntry} is missing — run \`npm run build\` first.`,
      );
    }
    return [opts.distEntry];
  }
  // Fail loud on a typo instead of silently degrading to tsx: an unknown value
  // (e.g. `dsit`) would otherwise make CI believe it tests dist while running
  // src. Unset / '' / 'src' remain the safe tsx-on-source default.
  if (opts.mode !== undefined && opts.mode !== '' && opts.mode !== 'src') {
    throw new Error(
      `Unknown GITNEXUS_E2E_CLI value '${opts.mode}' — use 'dist', 'src', or leave unset.`,
    );
  }
  return ['--import', opts.tsxLoaderUrl, opts.srcEntry];
}

export function tsxLoaderUrl(): string {
  // Absolute file:// URL to the tsx loader — a bare `tsx` specifier won't resolve
  // when the CLI is spawned with a cwd outside the project tree. The subpath
  // `tsx/dist/loader.mjs` isn't in tsx's `exports`, so resolve the package root
  // then join. Only computed on the tsx path (never when dist is selected).
  return pathToFileURL(
    path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs'),
  ).href;
}

function resolvePrefix(): string[] {
  const mode = process.env.GITNEXUS_E2E_CLI;
  return computeSpawnPrefix({
    mode,
    distEntry,
    srcEntry,
    distExists: mode === 'dist' && fs.existsSync(distEntry),
    // Resolve the tsx loader lazily so the dist path pays nothing for it.
    tsxLoaderUrl: mode === 'dist' ? '' : tsxLoaderUrl(),
  });
}

/**
 * `node` argv prefix that launches the gitnexus CLI (built dist when
 * `GITNEXUS_E2E_CLI=dist`, else tsx-on-source). Spread it before the CLI's own
 * arguments:
 *
 *     spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'analyze', repo], opts)
 */
export const CLI_SPAWN_PREFIX: readonly string[] = resolvePrefix();
