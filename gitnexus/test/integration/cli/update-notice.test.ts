import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { CLI_SPAWN_PREFIX, tsxLoaderUrl } from '../../helpers/cli-entry.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
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
    fs.rmSync(dir, { recursive: true, force: true });
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
    expect(result.stdout).not.toContain('__update-check');
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

    const preload = path.join(home, 'mock-refresh.mjs');
    fs.writeFileSync(
      preload,
      `Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
globalThis.fetch = async () => {
  await new Promise((resolve) => setTimeout(resolve, 750));
  return new Response(JSON.stringify({ version: '99.0.0' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
`,
    );

    const startedAt = Date.now();
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
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1_800);
    const cache = path.join(home, 'update-check.json');
    expect(fs.existsSync(cache)).toBe(false);
    await expect.poll(() => fs.existsSync(cache), { timeout: 5_000, interval: 100 }).toBe(true);
    expect(JSON.parse(fs.readFileSync(cache, 'utf8'))).toMatchObject({
      latestVersion: '99.0.0',
      registry: 'https://registry.npmjs.org',
    });
  }, 10_000);

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

    expect(result.stderr).toContain('GitNexus 99.0.0 is available (you are running 1.6.10).');
    expect(result.stdout).not.toContain('99.0.0 is available');
  });
});
