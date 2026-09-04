import { spawn as nodeSpawn } from 'node:child_process';
import { updateEligibleInstallSync } from '../core/install-context.js';
import {
  isNewerVersion,
  readValidatedUpdateCacheSync,
  updateNotifierOptedOut,
  updateRefreshInProgress,
  type ValidatedUpdateCache,
} from '../core/update-cache.js';
import { t } from './i18n/index.js';

const EXCLUDED_COMMANDS = new Set([
  'augment',
  'mcp',
  'serve',
  'eval-server',
  'update',
  '__update-check',
]);
const EXCLUDED_FLAGS = new Set(['--help', '-h', '--version', '-V']);

type SpawnResult = { unref(): void };
type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: true; stdio: 'ignore' },
) => SpawnResult;

export interface CliUpdateNoticeDependencies {
  argv: string[];
  env: NodeJS.ProcessEnv;
  installedVersion: string;
  isTTY: boolean | undefined;
  eligible: boolean;
  now: number;
  readCache: (options: { env: NodeJS.ProcessEnv; now: number }) => ValidatedUpdateCache | null;
  writeStderr: (line: string) => unknown;
  spawn: SpawnLike;
}

function excludedInvocation(argv: string[]): boolean {
  const args = argv.slice(2);
  if (args.some((arg) => EXCLUDED_FLAGS.has(arg))) return true;
  const command = args.find((arg) => !arg.startsWith('-'));
  return command !== undefined && EXCLUDED_COMMANDS.has(command);
}

export function updateNoticeText(installedVersion: string, latestVersion: string): string {
  return t('update.available', { installedVersion, latestVersion });
}

/** Shared cache-gated notice line used by the CLI banner and `doctor`. */
export function cachedUpdateNoticeLine(options: {
  installedVersion: string;
  eligible: boolean;
  env: NodeJS.ProcessEnv;
  readCache: () => ValidatedUpdateCache | null;
}): string | null {
  try {
    if (!options.eligible || updateNotifierOptedOut(options.env)) return null;
    const cache = options.readCache();
    if (!cache?.latestVersion || !isNewerVersion(options.installedVersion, cache.latestVersion)) {
      return null;
    }
    return updateNoticeText(options.installedVersion, cache.latestVersion);
  } catch {
    return null;
  }
}

export function runCliUpdateNotice(deps: CliUpdateNoticeDependencies): void {
  try {
    if (
      deps.isTTY !== true ||
      updateNotifierOptedOut(deps.env) ||
      !deps.eligible ||
      excludedInvocation(deps.argv)
    ) {
      return;
    }

    const cache = deps.readCache({ env: deps.env, now: deps.now });
    if (cache?.latestVersion && isNewerVersion(deps.installedVersion, cache.latestVersion)) {
      deps.writeStderr(`${updateNoticeText(deps.installedVersion, cache.latestVersion)}\n`);
    }

    if (cache === null || cache.stale) {
      // Coalesce parallel invocations: when a live process holds the refresh
      // lock, its refresh covers us, so don't fork another CLI.
      if (!updateRefreshInProgress(deps.env)) {
        try {
          deps
            .spawn(process.execPath, [deps.argv[1] ?? '', '__update-check'], {
              detached: true,
              stdio: 'ignore',
            })
            .unref();
        } catch {
          // Update refresh is best-effort and must never reach Commander parsing.
        }
      }
    }
  } catch {
    // Cache reads and all adapter logic fail open.
  }
}

export function runProcessCliUpdateNotice(installedVersion: string): void {
  if (
    process.stderr.isTTY !== true ||
    updateNotifierOptedOut(process.env) ||
    excludedInvocation(process.argv)
  ) {
    return;
  }
  runCliUpdateNotice({
    argv: process.argv,
    env: process.env,
    installedVersion,
    isTTY: process.stderr.isTTY,
    eligible: updateEligibleInstallSync(),
    now: Date.now(),
    readCache: readValidatedUpdateCacheSync,
    writeStderr: (line) => process.stderr.write(line),
    spawn: nodeSpawn as unknown as SpawnLike,
  });
}
