import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

const launcher = path.resolve(__dirname, '../../../gitnexus-claude-plugin/hooks/gitnexus-hook.js');
const source = fs.readFileSync(launcher, 'utf8');
const realRequire = createRequire(import.meta.url);
const fixtures: string[] = [];
const children: ChildProcess[] = [];
const version = '1.6.12';

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-launcher-'));
  fixtures.push(root);
  return root;
}

function installedPackage(root: string, metadata: Record<string, unknown> = {}) {
  const cli = path.join(root, 'dist', 'cli', 'index.js');
  const hook = path.join(root, 'hooks', 'claude', 'gitnexus-hook.cjs');
  const marker = path.join(root, 'loaded');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'gitnexus', version, ...metadata }),
  );
  fs.writeFileSync(cli, '// CLI entry\n');
  fs.writeFileSync(
    hook,
    `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n`,
  );
  return { root, cli, hook, marker };
}

type Config = { cliPath: string; version: string };
type Api = {
  exactVersion: (version: unknown) => string;
  resolveRuntime: (config?: Config) => string | null;
  launcherConfig: () => Config;
  recoveryDirectory: (version: string) => string;
  readRecovery: (directory: string, version: string) => { runtime?: string; error?: string } | null;
  writeRecovery: (directory: string, state: Record<string, unknown>) => void;
  acquireInstallSlot: (directory: string) => (() => void) | null;
  runPackage: (command: string, args: string[], options: object) => Promise<void>;
  main: () => Promise<void>;
  RECOVERY_TIMEOUT: number;
  LOCK_MAX_AGE: number;
  FAILURE_COOLDOWN: number;
};

function load(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: string;
    directory?: string;
    home?: string;
    resolvedHook?: string;
    filesystem?: object;
    childProcess?: object;
    kill?: (pid: number, signal?: string | number) => void;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
  } = {},
) {
  const events = new EventEmitter();
  const resolve = vi.fn(() => {
    if (options.resolvedHook) return options.resolvedHook;
    throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' });
  });
  const api: Api = vm.runInNewContext(
    source.slice(0, source.lastIndexOf('\nmain().catch')) +
      '\n({exactVersion, resolveRuntime, launcherConfig, recoveryDirectory, readRecovery, writeRecovery, acquireInstallSlot, runPackage, main, RECOVERY_TIMEOUT, LOCK_MAX_AGE, FAILURE_COOLDOWN});',
    {
      require: Object.assign(
        (id: string) => {
          if (id === 'fs') return { ...fs, ...options.filesystem };
          if (id === 'os') return { ...os, homedir: () => options.home ?? fixture() };
          if (id === 'child_process') return options.childProcess ?? { spawn, spawnSync };
          return realRequire(id);
        },
        { resolve },
      ),
      Buffer,
      __dirname: options.directory ?? path.dirname(launcher),
      __filename: launcher,
      setTimeout: options.setTimeout ?? setTimeout,
      clearTimeout: options.clearTimeout ?? clearTimeout,
      process: {
        argv: [process.execPath, launcher],
        pid: process.pid,
        platform: options.platform ?? process.platform,
        execPath: process.execPath,
        env: options.env ?? {},
        kill: options.kill ?? process.kill,
        once: events.once.bind(events),
        removeListener: events.removeListener.bind(events),
      },
    },
  );
  return { api, resolve, events };
}

// npm quotes arguments but treats the command itself as shell source. Use its
// actual shell executor: shell-less spawn fakes cannot catch path quoting bugs.
function npmShellExecutor() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(
      path.dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const cli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!cli)
    throw new Error('Run launcher shell regressions through npm test (npm executable required)');
  return createRequire(fs.realpathSync(cli)).resolve('@npmcli/promise-spawn');
}

function recoveryFixture(
  options: { interpreter?: boolean; cmdFallback?: boolean; kind?: 'plugin' | 'installed' } = {},
) {
  const root = fixture();
  const home = path.join(root, 'home');
  const hooks = path.join(root, "bootstrap spaces & 'quote' $cash %percent%", 'hooks');
  const npmPrefix = path.join(root, 'npm');
  const pkg = installedPackage(path.join(root, 'cache', 'node_modules', 'gitnexus'));
  const bin = path.join(root, 'cache', 'node_modules', '.bin');
  fs.mkdirSync(home);
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(npmPrefix);
  fs.mkdirSync(bin);
  if (process.platform === 'win32')
    fs.writeFileSync(path.join(bin, 'gitnexus.cmd'), '@echo shim\r\n');
  else {
    fs.chmodSync(pkg.cli, 0o755);
    fs.symlinkSync(pkg.cli, path.join(bin, 'gitnexus'));
  }
  const entry = path.join(hooks, 'gitnexus-hook.cjs');
  fs.writeFileSync(entry, source);
  if (options.kind === 'installed') {
    fs.writeFileSync(
      path.join(hooks, 'gitnexus-hook.json'),
      JSON.stringify({
        version,
        cliPath: path.join(root, 'uninstalled', 'dist', 'cli', 'index.js'),
      }),
    );
  } else {
    fs.mkdirSync(path.join(path.dirname(hooks), '.claude-plugin'));
    fs.writeFileSync(
      path.join(path.dirname(hooks), '.claude-plugin', 'plugin.json'),
      JSON.stringify({ version }),
    );
  }
  let interpreter = process.execPath;
  if (options.interpreter) {
    interpreter = path.join(
      root,
      "node spaces & 'quote' $cash %percent%",
      path.basename(process.execPath),
    );
    fs.mkdirSync(path.dirname(interpreter));
    fs.copyFileSync(process.execPath, interpreter);
    fs.chmodSync(interpreter, 0o755);
  }
  const log = path.join(root, 'npm.jsonl');
  const started = path.join(root, 'started');
  const finished = path.join(root, 'finished');
  const npmSource = `const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, cwd:process.cwd(), foreground:process.env.npm_config_foreground_scripts, input:fs.readFileSync(0).length}) + '\\n');
fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
process.stdout.write('npm lifecycle stdout must not become hook JSON\\n');
if (process.env.TEST_OUTPUT_CAP) process.stdout.write(Buffer.alloc(1024*1024+1));
setTimeout(async () => {
  try {
    if (process.env.TEST_FAILURE) throw new Error('offline fixture failure');
    const separator = args.indexOf('--');
    await require(${JSON.stringify(npmShellExecutor())})(args[separator+1], args.slice(separator+2), {
      shell: process.platform === 'win32' ? process.env.ComSpec : '/bin/sh', stdio:'inherit',
      env: {...process.env, PATH:${JSON.stringify(bin)}+require('path').delimiter+process.env.PATH}
    });
    fs.writeFileSync(${JSON.stringify(finished)}, 'done');
  } catch(error) { process.stderr.write(error.message); process.exitCode=1; }
}, Number(process.env.TEST_DELAY || 0));
`;
  const npmJs =
    process.platform === 'win32' && !options.cmdFallback
      ? path.join(npmPrefix, 'node_modules', 'npm', 'bin', 'npx-cli.js')
      : path.join(npmPrefix, 'npx-fixture.cjs');
  fs.mkdirSync(path.dirname(npmJs), { recursive: true });
  fs.writeFileSync(npmJs, npmSource);
  if (process.platform === 'win32')
    fs.writeFileSync(path.join(npmPrefix, 'npx.cmd'), '@"%__TEST_NODE%" "%__TEST_NPX%" %*\r\n');
  else
    fs.writeFileSync(
      path.join(npmPrefix, 'npx'),
      `#!${process.execPath}\nrequire(${JSON.stringify(npmJs)});\n`,
      { mode: 0o755 },
    );
  fs.writeFileSync(
    pkg.hook,
    `const fs=require('fs');process.stdout.write(JSON.stringify({version:${JSON.stringify(version)},input:fs.readFileSync(0).toString('base64'),pid:process.pid}));\n`,
  );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: npmPrefix,
    NODE_PATH: '',
    GITNEXUS_HOOK_CLI_PATH: '',
    GITNEXUS_DEBUG: '',
    __GITNEXUS_HOOK_MODE: '',
    __TEST_NODE: interpreter,
    __TEST_NPX: npmJs,
  };
  const directory = load({ home }).api.recoveryDirectory(version);
  const input = Buffer.from(' {"pattern":"雪 & $(touch nope) %TEMP%"}\r\n');
  function start(extraEnv: NodeJS.ProcessEnv = {}, customInput = input) {
    const child = spawn(interpreter, [entry], {
      cwd: root,
      env: { ...env, ...extraEnv },
      windowsHide: true,
    });
    children.push(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (data) => stdout.push(data));
    child.stderr.on('data', (data) => stderr.push(data));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') throw error;
    });
    child.stdin.end(customInput);
    const done = new Promise<{
      status: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) =>
        resolve({
          status,
          signal,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        }),
      );
    });
    return { child, done };
  }
  return { root, home, pkg, entry, log, started, finished, directory, input, start, npmPrefix };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for process fixture');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function logRows(log: string) {
  return fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('Claude plugin package launcher validation', () => {
  it('loads a validated package without consuming stdin or starting npm', async () => {
    const pkg = installedPackage(fixture());
    const spawn = vi.fn();
    const readFileSync = vi.fn(fs.readFileSync);
    const { api, resolve } = load({
      resolvedHook: pkg.hook,
      filesystem: { readFileSync },
      childProcess: { spawn },
    });
    await api.main();
    expect(fs.existsSync(pkg.marker)).toBe(true);
    expect(resolve).toHaveBeenCalledWith('gitnexus/hooks/claude/gitnexus-hook.cjs');
    expect(readFileSync.mock.calls.some((args) => args[0] === 0)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('validates require.resolve package name, metadata and canonical layout', () => {
    const pkg = installedPackage(fixture(), { name: 'other-package' });
    expect(load({ resolvedHook: pkg.hook }).api.resolveRuntime()).toBeNull();
    fs.writeFileSync(
      path.join(pkg.root, 'package.json'),
      JSON.stringify({ name: 'gitnexus', version: 'latest' }),
    );
    expect(() => load({ resolvedHook: pkg.hook }).api.resolveRuntime()).toThrow(
      'exact package version',
    );
    const arbitrary = path.join(pkg.root, 'arbitrary.cjs');
    fs.writeFileSync(arbitrary, '');
    expect(load({ resolvedHook: arbitrary }).api.resolveRuntime()).toBeNull();
  });
  it('uses a real environment override before configuration and ignores augment fixtures', () => {
    const configured = installedPackage(fixture());
    const override = installedPackage(fixture());
    const { api, resolve } = load({ env: { GITNEXUS_HOOK_CLI_PATH: override.cli } });
    expect(api.resolveRuntime({ cliPath: configured.cli, version })).toBe(override.hook);
    expect(resolve).not.toHaveBeenCalled();
    const augment = path.join(override.root, 'augment.cjs');
    fs.writeFileSync(augment, '');
    expect(
      load({ env: { GITNEXUS_HOOK_CLI_PATH: augment } }).api.resolveRuntime({
        cliPath: configured.cli,
        version,
      }),
    ).toBe(configured.hook);
  });
  it.each([{}, { cliPath: 'relative', version }, { cliPath: '/absolute', version: 'latest' }])(
    'rejects invalid configuration %j',
    (config) => {
      const directory = fixture();
      fs.writeFileSync(path.join(directory, 'gitnexus-hook.json'), JSON.stringify(config));
      expect(() => load({ directory }).api.launcherConfig()).toThrow();
    },
  );
  it('does not replace a corrupt installed package', async () => {
    const pkg = installedPackage(fixture());
    fs.writeFileSync(path.join(pkg.root, 'package.json'), '{broken');
    const spawn = vi.fn();
    await expect(
      load({ env: { GITNEXUS_HOOK_CLI_PATH: pkg.cli }, childProcess: { spawn } }).api.main(),
    ).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')('resolves Unix npm symlinks', () => {
    const root = fixture();
    const pkg = installedPackage(path.join(root, 'package'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.chmodSync(pkg.cli, 0o755);
    fs.symlinkSync(pkg.cli, path.join(bin, 'gitnexus'));
    expect(load({ env: { PATH: bin } }).api.resolveRuntime()).toBe(pkg.hook);
  });
  it('resolves Windows npm prefix shims without executing them', () => {
    const root = fixture();
    const pkg = installedPackage(path.join(root, 'node_modules', 'gitnexus'));
    fs.writeFileSync(path.join(root, 'gitnexus.cmd'), '@echo shim\n');
    expect(load({ platform: 'win32', env: { PATH: root } }).api.resolveRuntime()).toBe(pkg.hook);
  });
  it.each([undefined, '', 'latest', '^1.7.0', '01.7.0', '1.7.0\n', '1.7.0 & echo injected'])(
    'rejects non-exact version %j',
    (invalid) => {
      expect(() => load().api.exactVersion(invalid)).toThrow('exact package version');
    },
  );
  it('rejects deleted, wrong-version and wrong-name cached packages', () => {
    const home = fixture();
    const pkg = installedPackage(path.join(home, 'package'));
    const { api } = load({ home });
    const directory = api.recoveryDirectory(version);
    api.writeRecovery(directory, { version, runtime: pkg.hook });
    expect(api.readRecovery(directory, version)).toEqual({ runtime: pkg.hook });
    expect(api.readRecovery(directory, '1.6.13')).toBeNull();
    for (const metadata of [
      { name: 'gitnexus', version: '1.6.13' },
      { name: 'other', version },
      { name: 'gitnexus', version: 'latest' },
    ]) {
      fs.writeFileSync(path.join(pkg.root, 'package.json'), JSON.stringify(metadata));
      expect(api.readRecovery(directory, version)).toBeNull();
    }
    fs.rmSync(pkg.root, { recursive: true });
    expect(api.readRecovery(directory, version)).toBeNull();
    if (process.platform !== 'win32') {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(directory, 'runtime.json')).mode & 0o777).toBe(0o600);
    }
  });
  it('keeps the recovery and cleanup budgets within both host deadlines', () => {
    const { api } = load();
    const config = JSON.parse(
      fs.readFileSync(path.resolve(path.dirname(launcher), 'hooks.json'), 'utf8'),
    );
    const timeouts = Object.values(config.hooks).flatMap((rows) =>
      (rows as { hooks: { timeout: number }[] }[]).flatMap((row) =>
        row.hooks.map((hook) => hook.timeout * 1000),
      ),
    );
    expect(timeouts).toHaveLength(2);
    expect(api.RECOVERY_TIMEOUT).toBe(120000);
    expect(api.LOCK_MAX_AGE).toBeGreaterThan(api.RECOVERY_TIMEOUT + 2000 + 2 * 2000);
    for (const timeout of timeouts) expect(api.LOCK_MAX_AGE + 5000).toBeLessThan(timeout);
    expect(api.FAILURE_COOLDOWN).toBe(300000);
  });
  it('re-reads publication when the owner releases between a missing cache read and lock check', async () => {
    const home = fixture();
    const directory = fixture();
    const pkg = installedPackage(fixture());
    fs.writeFileSync(
      path.join(directory, 'gitnexus-hook.json'),
      JSON.stringify({ version, cliPath: path.join(home, 'deleted') }),
    );
    let published = false;
    const spawn = vi.fn(() => {
      const helper = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => helper.emit('exit', 0));
      return helper;
    });
    const { api } = load({
      home,
      directory,
      childProcess: { spawn },
      filesystem: {
        existsSync: (target: fs.PathLike) => {
          if (String(target).endsWith('install.lock')) {
            api.writeRecovery(api.recoveryDirectory(version), { version, runtime: pkg.hook });
            published = true;
            return false;
          }
          return fs.existsSync(target);
        },
      },
    });
    await api.main();
    expect(published).toBe(true);
    expect(fs.existsSync(pkg.marker)).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
  });
});

describe('package recovery with real npm shell semantics', () => {
  it.each(['plugin', 'installed'] as const)(
    'recovers once and isolates npm output from the %s hook',
    async (kind) => {
      const f = recoveryFixture({ kind });
      fs.writeFileSync(path.join(f.root, '.npmrc'), 'registry=http://must-not-be-used.invalid\n');
      const first = await f.start().done;
      expect(first.status, first.stderr).toBe(0);
      expect(first.stderr).toBe('');
      expect(JSON.parse(first.stdout)).toMatchObject({
        version,
        input: f.input.toString('base64'),
      });
      expect(logRows(f.log)).toEqual([
        expect.objectContaining({
          args: [
            '--yes',
            '--prefer-offline',
            `--package=gitnexus@${version}`,
            '--',
            'node',
            '-e',
            'require(process.env.__GITNEXUS_HOOK_BOOTSTRAP)',
          ],
          cwd: f.directory,
          foreground: 'false',
          input: 0,
        }),
      ]);
      expect(JSON.parse((await f.start().done).stdout)).toMatchObject({
        version,
        input: f.input.toString('base64'),
      });
      expect(logRows(f.log)).toHaveLength(1);
      expect(fs.existsSync(path.join(f.directory, 'install.lock'))).toBe(false);
    },
  );
  it.skipIf(process.platform === 'win32')(
    'executes the npm shell with metacharacters and spaces in node and bootstrap paths',
    async () => {
      const f = recoveryFixture({ interpreter: true });
      const result = await f.start().done;
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ input: f.input.toString('base64') });
      expect(logRows(f.log)).toHaveLength(1);
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'runs actual cmd.exe fallback with a spaced node and metacharacter bootstrap',
    async () => {
      const f = recoveryFixture({ interpreter: true, cmdFallback: true });
      const result = await f.start({ GITNEXUS_DEBUG: 'true' }).done;
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ input: f.input.toString('base64') });
      expect(logRows(f.log)).toHaveLength(1);
    },
  );
  it('delivers concurrent cold and cached calls without serializing runtime events', async () => {
    const f = recoveryFixture();
    const count = path.join(f.root, 'runtime-calls');
    fs.writeFileSync(
      f.pkg.hook,
      `const fs=require('fs');fs.readFileSync(0);fs.appendFileSync(${JSON.stringify(count)},String(process.pid)+'\\n');setTimeout(()=>process.stdout.write('done'),300);\n`,
    );
    const cold = await Promise.all(
      Array.from({ length: 4 }, () => f.start({ TEST_DELAY: '200' }).done),
    );
    expect(cold.map((result) => result.stdout)).toEqual(['done', 'done', 'done', 'done']);
    expect(logRows(f.log)).toHaveLength(1);
    const lock = path.join(f.directory, 'install.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, `${process.pid}-00000000.owner`), '');
    const warm = await Promise.all(Array.from({ length: 4 }, () => f.start().done));
    expect(warm.map((result) => result.stdout)).toEqual(['done', 'done', 'done', 'done']);
    expect(fs.readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(8);
    expect(logRows(f.log)).toHaveLength(1);
  });
  it.each([
    ['', false],
    ['0', false],
    ['false', false],
    ['true', true],
    ['1', true],
  ] as const)(
    'cools down failures and only diagnoses explicit debug %s',
    async (debug, diagnostic) => {
      const f = recoveryFixture();
      const failed = await f.start({ TEST_FAILURE: '1', GITNEXUS_DEBUG: debug }).done;
      expect(failed.stdout).toBe('');
      expect(Boolean(failed.stderr)).toBe(diagnostic);
      const warm = await f.start({ GITNEXUS_DEBUG: debug }).done;
      expect(warm.stdout).toBe('');
      expect(Boolean(warm.stderr)).toBe(diagnostic);
      expect(logRows(f.log)).toHaveLength(1);
      const stateFile = path.join(f.directory, 'runtime.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.error).toContain('offline fixture failure');
      state.failedAt = Date.now() - 300001;
      fs.writeFileSync(stateFile, JSON.stringify(state));
      expect(JSON.parse((await f.start().done).stdout)).toHaveProperty('version', version);
      expect(logRows(f.log)).toHaveLength(2);
    },
  );
  it('recovers again after the cached runtime is removed', async () => {
    const f = recoveryFixture();
    await f.start().done;
    const stateFile = path.join(f.directory, 'runtime.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.runtime = path.join(f.root, 'deleted', 'hooks', 'claude', 'gitnexus-hook.cjs');
    fs.writeFileSync(stateFile, JSON.stringify(state));
    expect(JSON.parse((await f.start().done).stdout)).toHaveProperty('version', version);
    expect(logRows(f.log)).toHaveLength(2);
  });
  it('caps npm output without emitting it as hook context', async () => {
    const f = recoveryFixture();
    const result = await f.start({
      TEST_OUTPUT_CAP: '1',
      TEST_DELAY: '1000',
      GITNEXUS_DEBUG: 'true',
    }).done;
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('exceeded 1 MiB');
    expect(fs.existsSync(path.join(f.directory, 'install.lock'))).toBe(false);
  });
  it.skipIf(process.platform === 'win32')(
    'keeps installation owned after SIGKILL of the outer caller',
    async () => {
      const f = recoveryFixture();
      const first = f.start({ TEST_DELAY: '800' });
      await waitFor(() => fs.existsSync(f.started));
      first.child.kill('SIGKILL');
      expect((await first.done).signal).toBe('SIGKILL');
      expect(JSON.parse((await f.start().done).stdout)).toHaveProperty('version', version);
      expect(logRows(f.log)).toHaveLength(1);
      expect(fs.existsSync(f.finished)).toBe(true);
      expect(fs.existsSync(path.join(f.directory, 'install.lock'))).toBe(false);
    },
  );
  it('expires a stale live-PID lock without signaling the reused process', async () => {
    const f = recoveryFixture();
    const lock = path.join(f.directory, 'install.lock');
    fs.mkdirSync(lock);
    const owner = path.join(lock, `${process.pid}-00000000.owner`);
    fs.writeFileSync(owner, '');
    fs.utimesSync(owner, new Date(0), new Date(0));
    expect(JSON.parse((await f.start().done).stdout)).toHaveProperty('version', version);
    expect(logRows(f.log)).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);
  });
  it('fails promptly if its helper cannot publish either result or cooldown', async () => {
    const f = recoveryFixture();
    fs.mkdirSync(path.join(f.directory, 'runtime.json'));
    const result = await f.start({ GITNEXUS_DEBUG: '1' }).done;
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('exited without a result');
    expect(fs.existsSync(path.join(f.directory, 'install.lock'))).toBe(false);
  });
  it.each([
    ['', false],
    ['true', true],
  ] as const)(
    'never downloads after an installed runtime throws (debug %s)',
    async (debug, diagnostic) => {
      const f = recoveryFixture();
      fs.writeFileSync(f.pkg.hook, "throw new Error('installed hook is broken');\n");
      const result = await f.start({ GITNEXUS_HOOK_CLI_PATH: f.pkg.cli, GITNEXUS_DEBUG: debug })
        .done;
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(Boolean(result.stderr)).toBe(diagnostic);
      expect(fs.existsSync(f.log)).toBe(false);
    },
  );
  it.each([false, true])(
    'recognizes opaque installed hook shims and tolerates early stdin close %s',
    async (earlyClose) => {
      const f = recoveryFixture();
      if (earlyClose) fs.writeFileSync(f.pkg.hook, 'process.exit(0);\n');
      const shim = path.join(
        f.npmPrefix,
        process.platform === 'win32' ? 'gitnexus-hook.cmd' : 'gitnexus-hook',
      );
      fs.writeFileSync(
        shim,
        process.platform === 'win32'
          ? '@"%__TEST_NODE%" "%__TEST_HOOK%"\r\n'
          : '#!/bin/sh\nexec node "$__TEST_HOOK"\n',
        { mode: 0o755 },
      );
      const result = await f.start(
        { __TEST_HOOK: f.pkg.hook, GITNEXUS_DEBUG: '1' },
        earlyClose ? Buffer.alloc(2 * 1024 * 1024) : f.input,
      ).done;
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      if (earlyClose) expect(result.stdout).toBe('');
      else expect(JSON.parse(result.stdout)).toMatchObject({ input: f.input.toString('base64') });
      expect(fs.existsSync(f.log)).toBe(false);
    },
  );
});

describe('recovery ownership and process cleanup', () => {
  it('recovers an interrupted reclaimer that left an empty lock', () => {
    const directory = fixture();
    const lock = path.join(directory, 'install.lock');
    fs.mkdirSync(lock);
    const release = load().api.acquireInstallSlot(directory);
    expect(release).toBeTypeOf('function');
    release?.();
    expect(fs.existsSync(lock)).toBe(false);
  });
  it('does not let a delayed stale reclaimer remove a replacement owner', () => {
    const directory = fixture();
    const lock = path.join(directory, 'install.lock');
    const oldOwner = path.join(lock, '99999-00000000.owner');
    fs.mkdirSync(lock);
    fs.writeFileSync(oldOwner, '');
    const kill = () => {
      throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    };
    const first = load({ kill }).api;
    let releaseFirst: (() => void) | null = null;
    const delayed = load({
      kill,
      filesystem: {
        unlinkSync: (target: fs.PathLike) => {
          if (String(target) === oldOwner) releaseFirst = first.acquireInstallSlot(directory);
          fs.unlinkSync(target);
        },
      },
    }).api;
    expect(delayed.acquireInstallSlot(directory)).toBeNull();
    expect(releaseFirst).toBeTypeOf('function');
    expect(fs.readdirSync(lock)).toHaveLength(1);
    expect(fs.readdirSync(lock)[0]).not.toBe(path.basename(oldOwner));
    (releaseFirst as (() => void) | null)?.();
    expect(fs.existsSync(lock)).toBe(false);
  });
  it.each(['timeout', 'signal'] as const)(
    'cleans up the install group on %s without touching stdin',
    async (cancel) => {
      const timers = new Map<number, { callback: () => void; delay: number }>();
      let id = 0;
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
        stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
        unref: vi.fn(),
      });
      const spawn = vi.fn(() => child);
      const kill = vi.fn();
      const { api, events } = load({
        platform: 'linux',
        childProcess: { spawn },
        kill,
        setTimeout: ((callback: () => void, delay: number) => {
          timers.set(++id, { callback, delay });
          return id;
        }) as unknown as typeof setTimeout,
        clearTimeout: ((id: number) => timers.delete(id)) as unknown as typeof clearTimeout,
      });
      const running = api.runPackage('npx', [], { cwd: fixture() });
      const rejected = expect(running).rejects.toThrow(
        cancel === 'timeout' ? 'timed out' : 'cancelled',
      );
      const fireTimer = (delay: number) => {
        const timer = [...timers.values()].find((timer) => timer.delay === delay);
        if (!timer) throw new Error(`Expected a ${delay} ms timer`);
        timer.callback();
      };
      if (cancel === 'timeout') fireTimer(120000);
      else events.emit('SIGTERM');
      fireTimer(2000);
      await rejected;
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(spawn).toHaveBeenCalledWith(
        'npx',
        [],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      );
      expect(child.stdout.destroy).toHaveBeenCalledOnce();
      expect(child.stderr.destroy).toHaveBeenCalledOnce();
      expect(child.unref).toHaveBeenCalledOnce();
      expect(timers.size).toBe(0);
      expect(events.listenerCount('SIGTERM')).toBe(0);
    },
  );
  it('terminates Windows npm descendants with taskkill, not a shell', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const spawnSync = vi.fn(() => {
      queueMicrotask(() => child.emit('close', null));
      return { status: 0 };
    });
    const kill = vi.fn();
    const { api, events } = load({
      platform: 'win32',
      childProcess: { spawn: () => child, spawnSync },
      kill,
    });
    const running = api.runPackage('npx', [], {});
    const rejected = expect(running).rejects.toThrow('cancelled');
    events.emit('SIGTERM');
    await rejected;
    expect(spawnSync).toHaveBeenCalledWith(
      path.join('C:\\Windows', 'System32', 'taskkill.exe'),
      ['/pid', '4242', '/T', '/F'],
      { timeout: 2000, windowsHide: true, stdio: 'ignore' },
    );
    expect(kill).not.toHaveBeenCalled();
    expect(events.listenerCount('SIGTERM')).toBe(0);
  });
});
