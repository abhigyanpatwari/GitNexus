/**
 * Explicit `gitnexus update`: refresh the latest dist-tag, then install
 * `gitnexus@<version>` globally with npm — the same shape as `claude update`
 * / `codex update`. Other commands only notify; they never spawn npm.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { composeWin32NpmCommand } from '../core/embeddings/runtime-install.js';
import { STRICT_UPDATE_VERSION } from '../core/update-cache.js';
import { refresh, type UpdateState } from '../core/update-check.js';
import { t } from './i18n/index.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json') as { version?: unknown };

export const UPDATE_PACKAGE = 'gitnexus';

export interface UpdateCommandDependencies {
  installedVersion: string;
  refresh: (options: {
    eligible: true;
    ignoreOptOut: true;
    installedVersion: string;
  }) => Promise<UpdateState | null>;
  writeStdout: (line: string) => void;
  runInstall: (version: string) => Promise<number>;
  setExitCode: (code: number) => void;
}

function defaultInstalledVersion(): string {
  return typeof pkg.version === 'string' ? pkg.version : '';
}

export function updateInstallArgs(version: string): string[] {
  return ['i', '-g', `${UPDATE_PACKAGE}@${version}`];
}

export function updateInstallCommand(version: string): string {
  return `npm ${updateInstallArgs(version).join(' ')}`;
}

function isTestDeps(value: unknown): value is Partial<UpdateCommandDependencies> {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('refresh' in value || 'runInstall' in value || 'writeStdout' in value)
  );
}

function defaultRunInstall(version: string): Promise<number> {
  const args = updateInstallArgs(version);
  return new Promise((resolve, reject) => {
    const child =
      process.platform === 'win32'
        ? spawn(composeWin32NpmCommand(args), {
            cwd: homedir(),
            windowsHide: true,
            shell: true,
            stdio: 'inherit',
          })
        : spawn('npm', args, {
            cwd: homedir(),
            windowsHide: true,
            stdio: 'inherit',
          });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

export async function updateCommand(maybeDeps?: unknown): Promise<void> {
  const deps = isTestDeps(maybeDeps) ? maybeDeps : {};
  const installedVersion = deps.installedVersion ?? defaultInstalledVersion();
  const runRefresh = deps.refresh ?? refresh;
  const writeStdout = deps.writeStdout ?? ((line: string) => console.log(line));
  const runInstall = deps.runInstall ?? defaultRunInstall;
  const setExitCode =
    deps.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  const state = await runRefresh({
    eligible: true,
    ignoreOptOut: true,
    installedVersion,
  });

  const latestVersion =
    state?.latestVersion && STRICT_UPDATE_VERSION.test(state.latestVersion)
      ? state.latestVersion
      : undefined;
  if (state?.updateAvailable && latestVersion) {
    writeStdout(t('update.available', { installedVersion, latestVersion }));
    writeStdout(t('update.installing', { command: updateInstallCommand(latestVersion) }));
    try {
      const code = await runInstall(latestVersion);
      if (code !== 0) {
        writeStdout(t('update.installFailed', { command: updateInstallCommand(latestVersion) }));
        setExitCode(code);
        return;
      }
    } catch (error) {
      writeStdout(
        t('update.installError', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      setExitCode(1);
      return;
    }
    writeStdout(t('update.installed', { version: latestVersion }));
    return;
  }

  if (latestVersion) {
    writeStdout(t('update.current', { installedVersion }));
    return;
  }

  writeStdout(t('update.checkFailed'));
}
