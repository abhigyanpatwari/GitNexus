import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { CLI_SPAWN_PREFIX, tsxLoaderUrl } from '../../helpers/cli-entry.js';
import { cleanupTempDirSync } from '../../helpers/test-db.js';
import { packageVersion } from '../../../src/core/package-version.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const installedVersion = packageVersion();
const tempDirs: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cli-update-notice-'));
  tempDirs.push(dir);
  return dir;
}

function seededCache(home: string): string {
  const file = path.join(home, 'update-check.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      lastCheckAt: '2000-01-01T00:00:00.000Z',
      registry: 'https://registry.npmjs.org',
      latestVersion: '99.0.0',
    })}\n`,
  );
  return file;
}

function localeEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GITNEXUS_HOME: home,
    CI: '',
    GITNEXUS_NO_UPDATE_NOTIFIER: '',
    NO_UPDATE_NOTIFIER: '',
    GITNEXUS_LANG: 'en',
    LC_ALL: '',
    LC_MESSAGES: '',
    LANG: 'C',
  };
}

function cli(args: string[], home: string) {
  return spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: localeEnv(home),
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    cleanupTempDirSync(dir);
  }
});

describe('CLI update notice subprocess behavior', () => {
  it('keeps non-TTY stdout byte-clean and neither emits nor spawns a refresh child', () => {
    const home = tempHome();
    const cache = seededCache(home);
    const before = fs.readFileSync(cache, 'utf8');

    // `list` is a normal command (not --version/--help, which skip the notifier).
    const result = cli(['list'], home);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('is available');
    expect(result.stdout).not.toContain('99.0.0 is available');
    expect(fs.readFileSync(cache, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(home, 'update-check.lock'))).toBe(false);
  });

  it('keeps help output unchanged and hides the internal refresh command', () => {
    const result = cli(['--help'], tempHome());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: gitnexus [options] [command]');
    expect(result.stdout).toContain('update');
    expect(result.stdout).not.toContain('__update-check');
    expect(result.stderr).toBe('');
  });

  it('prints a versioned command banner on stderr for a normal command', () => {
    const result = cli(['list'], tempHome());

    expect(result.stderr).toMatch(/GitNexus List \([^)]+\)/);
    expect(result.stdout).not.toMatch(/GitNexus List \(/);
  });

  it('documents that gitnexus update installs via npm i -g', () => {
    const result = cli(['update', '--help'], tempHome());

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/npm i -g gitnexus@<x\.y\.z>/);
    expect(result.stderr).toBe('');
  });

  it('runs the hidden refresh command without writing stdout', () => {
    const result = cli(['__update-check'], tempHome());

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('lets the parent exit without waiting for a detached refresh child', async () => {
    const home = tempHome();
    const project = path.join(home, 'project');
    const installedPackage = path.join(project, 'node_modules', 'gitnexus');
    fs.mkdirSync(installedPackage, { recursive: true });
    fs.cpSync(path.join(repoRoot, 'src'), path.join(installedPackage, 'src'), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(repoRoot, 'package.json'),
      path.join(installedPackage, 'package.json'),
    );
    fs.symlinkSync(
      path.join(repoRoot, 'node_modules'),
      path.join(installedPackage, 'node_modules'),
      'dir',
    );

    // The refresh child parks inside fetch() until this test releases it. That
    // orders the parent's exit against work that is provably still in flight,
    // instead of racing it against a wall-clock budget: the child's real cost
    // (node boot, tsx transpile, a lock acquisition that shells out to
    // ps/powershell) has no bounded upper limit on a loaded CI runner.
    const started = path.join(home, 'refresh-started');
    const release = path.join(home, 'refresh-release');
    const preload = path.join(home, 'mock-refresh.mjs');
    fs.writeFileSync(
      preload,
      `import fs from 'node:fs';
Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
globalThis.fetch = async () => {
  fs.writeFileSync(${JSON.stringify(started)}, '');
  // Bounded so an abandoned child (test failed before releasing, temp home
  // already deleted) still exits instead of spinning forever.
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return new Response(JSON.stringify({ version: '99.0.0' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
`,
    );

    await new Promise<void>((resolve, reject) => {
      const parent = spawn(
        process.execPath,
        [path.join(installedPackage, 'src', 'cli', 'index.ts'), 'list'],
        {
          cwd: project,
          stdio: 'ignore',
          env: {
            ...localeEnv(home),
            NODE_OPTIONS:
              `--import ${tsxLoaderUrl()} --import ${pathToFileURL(preload).href}`.trim(),
          },
        },
      );
      parent.once('error', reject);
      parent.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`notifier parent exited ${String(code)}`));
      });
    });

    // The parent already exited above, so reaching a still-parked child proves
    // the refresh outlived it and was never awaited.
    const cache = path.join(home, 'update-check.json');
    await expect.poll(() => fs.existsSync(started), { timeout: 30_000, interval: 50 }).toBe(true);
    expect(fs.existsSync(cache)).toBe(false);

    fs.writeFileSync(release, '');
    await expect.poll(() => fs.existsSync(cache), { timeout: 30_000, interval: 50 }).toBe(true);
    expect(JSON.parse(fs.readFileSync(cache, 'utf8'))).toMatchObject({
      latestVersion: '99.0.0',
      registry: 'https://registry.npmjs.org',
    });
  }, 90_000);

  it('prints the localized notice on a forced-TTY stderr and keeps stdout clean', () => {
    const home = tempHome();
    fs.writeFileSync(
      path.join(home, 'update-check.json'),
      `${JSON.stringify({
        lastCheckAt: new Date().toISOString(),
        registry: 'https://registry.npmjs.org',
        latestVersion: '99.0.0',
      })}\n`,
    );
    const project = path.join(home, 'project');
    const installedPackage = path.join(project, 'node_modules', 'gitnexus');
    fs.mkdirSync(installedPackage, { recursive: true });
    fs.cpSync(path.join(repoRoot, 'src'), path.join(installedPackage, 'src'), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(repoRoot, 'package.json'),
      path.join(installedPackage, 'package.json'),
    );
    fs.symlinkSync(
      path.join(repoRoot, 'node_modules'),
      path.join(installedPackage, 'node_modules'),
      'dir',
    );

    const preload = path.join(home, 'force-tty.mjs');
    fs.writeFileSync(
      preload,
      `Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });\n`,
    );

    const result = spawnSync(
      process.execPath,
      [path.join(installedPackage, 'src', 'cli', 'index.ts'), 'list'],
      {
        cwd: project,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...localeEnv(home),
          NODE_OPTIONS: `--import ${tsxLoaderUrl()} --import ${pathToFileURL(preload).href}`.trim(),
        },
      },
    );

    expect(result.stderr).toContain(
      `GitNexus 99.0.0 is available (you are running ${installedVersion}).`,
    );
    expect(result.stdout).not.toContain('99.0.0 is available');
  });
});
