/**
 * Locks the vitest5 runner's version guard (KTD2): the Vitest resolved from the project root must
 * be 5.0.x, and the plugin location must resolve the same Vitest copy.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSupportedVitest,
  checkVitestInstalls,
  resolveVitestInstall,
  type VitestInstall,
} from '../../../tools/mutation/runner/version-guard.js';

const install = (version: string, packageJsonPath = '/repo/node_modules/vitest/package.json') =>
  ({ version, packageJsonPath }) satisfies VitestInstall;

describe('checkVitestInstalls', () => {
  it('accepts Vitest 5.0.5 resolved to one copy from both locations', () => {
    expect(checkVitestInstalls(install('5.0.5'), install('5.0.5'))).toEqual(install('5.0.5'));
  });

  it.each(['5.1.0', '4.1.12', '5.0.5-beta.1', '6.0.0'])('rejects Vitest %s', (version) => {
    expect(() => checkVitestInstalls(install(version), install(version))).toThrow(/5\.0\.x/);
  });

  it('rejects a second Vitest copy resolved from the plugin location', () => {
    expect(() =>
      checkVitestInstalls(
        install('5.0.5'),
        install('5.0.5', '/plugin/node_modules/vitest/package.json'),
      ),
    ).toThrow(/second Vitest copy/);
  });

  it('rejects a project root that resolves no Vitest', () => {
    expect(() => checkVitestInstalls(undefined, install('5.0.5'))).toThrow(/project root/);
  });

  it('rejects a plugin location that resolves no Vitest', () => {
    expect(() => checkVitestInstalls(install('5.0.5'), undefined)).toThrow(/plugin location/);
  });
});

describe('resolveVitestInstall and assertSupportedVitest', () => {
  let root: string;

  const fakeVitest = (dir: string, version: string): void => {
    const pkgDir = path.join(dir, 'node_modules', 'vitest');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'vitest', version }));
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gitnexus-version-guard-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the version and real path of the Vitest a directory resolves', () => {
    const project = path.join(root, 'project');
    fakeVitest(project, '5.0.5');

    expect(resolveVitestInstall(path.join(project, 'test'))).toEqual({
      version: '5.0.5',
      packageJsonPath: path.join(project, 'node_modules', 'vitest', 'package.json'),
    });
  });

  it('returns undefined when no Vitest resolves', () => {
    const empty = path.join(root, 'empty');
    mkdirSync(empty);

    expect(resolveVitestInstall(empty)).toBeUndefined();
  });

  it('accepts a project whose node_modules is a symlink to the plugin copy', () => {
    const checkout = path.join(root, 'checkout');
    const prepared = path.join(root, 'prepared');
    fakeVitest(checkout, '5.0.5');
    mkdirSync(prepared);
    symlinkSync(path.join(checkout, 'node_modules'), path.join(prepared, 'node_modules'), 'dir');

    expect(assertSupportedVitest(prepared, path.join(checkout, 'tools')).version).toBe('5.0.5');
  });

  it('rejects a plugin that resolves its own Vitest copy', () => {
    const project = path.join(root, 'project');
    const plugin = path.join(root, 'plugin');
    fakeVitest(project, '5.0.5');
    fakeVitest(plugin, '5.0.5');

    expect(() => assertSupportedVitest(project, plugin)).toThrow(/second Vitest copy/);
  });

  it('rejects a project that resolves Vitest 5.1.0', () => {
    const project = path.join(root, 'project');
    fakeVitest(project, '5.1.0');

    expect(() => assertSupportedVitest(project, project)).toThrow(/5\.1\.0/);
  });
});
