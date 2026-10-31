/**
 * Version guard of the vitest5 runner (KTD2).
 *
 * At init the runner reads the Vitest resolved from the project root (the Stryker sandbox) and
 * refuses anything outside 5.0.x. The setup file and the plugin import Vitest from the plugin's
 * own location; a second Vitest copy there is an error, because `inject` in the setup file then
 * reads another copy's provided context and returns undefined. Copies are compared by the real
 * path of their package.json, so a symlinked node_modules (the prepared copy) is one copy.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const SUPPORTED_VITEST = '5.0.x';
const SUPPORTED_VERSION = /^5\.0\.(?:0|[1-9]\d*)$/;

export interface VitestInstall {
  version: string;
  /** Real path of the resolved `vitest/package.json`. */
  packageJsonPath: string;
}

/** The Vitest that Node resolves from `fromDir`, or undefined when none resolves. */
export function resolveVitestInstall(fromDir: string): VitestInstall | undefined {
  let resolved: string;
  try {
    resolved = createRequire(path.join(fromDir, '__resolve__.js')).resolve('vitest/package.json');
  } catch {
    return undefined;
  }
  const packageJsonPath = realpathSync(resolved);
  const data: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const version =
    typeof data === 'object' &&
    data !== null &&
    'version' in data &&
    typeof data.version === 'string'
      ? data.version
      : '';
  return { version, packageJsonPath };
}

export function checkVitestInstalls(
  fromProject: VitestInstall | undefined,
  fromPlugin: VitestInstall | undefined,
): VitestInstall {
  if (fromProject === undefined) {
    throw new Error('vitest5 runner: no Vitest resolves from the project root');
  }
  if (!SUPPORTED_VERSION.test(fromProject.version)) {
    throw new Error(
      `vitest5 runner: Vitest ${fromProject.version} at ${fromProject.packageJsonPath} is not ` +
        `supported; the runner is validated on ${SUPPORTED_VITEST} only (KTD2)`,
    );
  }
  if (fromPlugin === undefined) {
    throw new Error(
      'vitest5 runner: no Vitest resolves from the plugin location, so its setup file cannot ' +
        'import Vitest',
    );
  }
  if (fromPlugin.packageJsonPath !== fromProject.packageJsonPath) {
    throw new Error(
      `vitest5 runner: the plugin location resolves a second Vitest copy ` +
        `(${fromPlugin.packageJsonPath}, project: ${fromProject.packageJsonPath}); inject() in ` +
        'the setup file would return undefined',
    );
  }
  return fromProject;
}

export function assertSupportedVitest(projectRoot: string, pluginDir: string): VitestInstall {
  return checkVitestInstalls(resolveVitestInstall(projectRoot), resolveVitestInstall(pluginDir));
}
