import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawnSync as realSpawnSync, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

const launcher = path.resolve(__dirname, '../../../gitnexus-claude-plugin/hooks/gitnexus-hook.js');
const source = fs.readFileSync(launcher, 'utf8');
const realRequire = createRequire(import.meta.url);
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-launcher-'));
  fixtures.push(root);
  return root;
}

function installedPackage(root: string, broken = false) {
  const cli = path.join(root, 'dist', 'cli', 'index.js');
  const hook = path.join(root, 'hooks', 'claude', 'gitnexus-hook.cjs');
  const marker = path.join(root, 'loaded');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'gitnexus' }));
  fs.writeFileSync(cli, '// CLI entry\n');
  fs.writeFileSync(
    hook,
    broken
      ? "throw new Error('installed hook is broken');\n"
      : `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n`,
  );
  return { cli, hook, marker };
}

async function execute(
  options: {
    resolvedHook?: string;
    version?: unknown;
    platform?: string;
    env?: NodeJS.ProcessEnv;
    input?: Buffer;
    childStatus?: number;
    directory?: string;
    cancel?: 'timeout' | 'signal';
    ignoreTermination?: boolean;
    packageMode?: boolean;
    lockOwner?: 'live' | 'dead' | 'empty';
  } = {},
) {
  const input = options.input ?? Buffer.from('{"hook_event_name":"PreToolUse"}\n');
  const stdinRead = vi.fn(() => input);
  const stdout = vi.fn();
  const stderr = vi.fn();
  const lockDirectory = fixture();
  const lockKey = createHash('sha256')
    .update(`${os.homedir()}\0gitnexus@1.7.0-rc.2`)
    .digest('hex')
    .slice(0, 24);
  const lock = path.join(lockDirectory, `gitnexus-hook-install-${lockKey}.lock`);
  if (options.lockOwner) {
    fs.mkdirSync(lock);
    if (options.lockOwner !== 'empty')
      fs.writeFileSync(path.join(lock, '99999-00000000.owner'), '');
  }
  const processEvents = new EventEmitter();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() }),
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    unref: vi.fn(),
  });
  child.stdin.end.mockImplementation(() =>
    queueMicrotask(() => {
      if (options.cancel === 'timeout') {
        [...timers.values()].find((timer) => timer.delay === 120000)?.callback();
      } else if (options.cancel === 'signal') {
        processEvents.emit('SIGTERM');
      } else {
        child.stdout.emit('data', Buffer.from('{"hookSpecificOutput":{}}\n'));
        child.stderr.emit('data', Buffer.from('npm diagnostic'));
        child.emit('close', options.childStatus ?? 0);
      }
      if (options.ignoreTermination) {
        [...timers.values()].find((timer) => timer.delay === 2000)?.callback();
      }
    }),
  );
  const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => child);
  const kill = vi.fn((_pid: number, signal: string | number) => {
    if (signal === 0) {
      if (options.lockOwner === 'dead')
        throw Object.assign(new Error('no process'), { code: 'ESRCH' });
      return;
    }
    if (signal === 'SIGKILL' || !options.ignoreTermination) {
      queueMicrotask(() => child.emit('close', null));
    }
  });
  const spawnSync = vi.fn(() => {
    queueMicrotask(() => child.emit('close', null));
    return { status: 0 };
  });
  const resolve = vi.fn(() => {
    if (options.resolvedHook) return options.resolvedHook;
    throw Object.assign(new Error('package not found'), { code: 'MODULE_NOT_FOUND' });
  });
  const require = Object.assign(
    (id: string) => {
      if (id === 'fs')
        return {
          ...fs,
          readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
            args[0] === 0 ? stdinRead() : fs.readFileSync(...args),
        };
      if (id === 'child_process') return { spawn, spawnSync };
      if (id === 'os') return { ...os, tmpdir: () => lockDirectory };
      if (id === '../.claude-plugin/plugin.json')
        return { version: Object.hasOwn(options, 'version') ? options.version : '1.7.0-rc.2' };
      return realRequire(id);
    },
    { resolve },
  );
  await vm.runInNewContext(source, {
    require,
    Buffer,
    __dirname: options.directory ?? path.dirname(launcher),
    __filename: launcher,
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    process: {
      argv: [process.execPath, launcher, ...(options.packageMode ? ['--package-runtime'] : [])],
      pid: process.pid,
      platform: options.platform ?? 'linux',
      execPath: process.execPath,
      env: options.env ?? {},
      kill,
      once: processEvents.once.bind(processEvents),
      removeListener: processEvents.removeListener.bind(processEvents),
      stdout: { write: stdout },
      stderr: { write: stderr },
    },
  });
  return {
    spawn,
    spawnSync,
    stdout,
    stderr,
    stdinRead,
    resolve,
    input,
    child,
    kill,
    timers,
    processEvents,
    lock,
  };
}

describe('Claude plugin package launcher', () => {
  it('loads the resolved package hook in-process without consuming stdin or invoking npm', async () => {
    const pkg = installedPackage(fixture());
    const result = await execute({ resolvedHook: pkg.hook });
    expect(fs.readFileSync(pkg.marker, 'utf8')).toBe(String(process.pid));
    expect(result.resolve).toHaveBeenCalledWith('gitnexus/hooks/claude/gitnexus-hook.cjs');
    expect(result.stdinRead).not.toHaveBeenCalled();
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it('uses a CLI override only when it identifies the canonical package layout', async () => {
    const pkg = installedPackage(fixture());
    const result = await execute({ env: { GITNEXUS_HOOK_CLI_PATH: pkg.cli } });
    expect(fs.existsSync(pkg.marker)).toBe(true);
    expect(result.resolve).not.toHaveBeenCalled();
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it('ignores an augment fixture override while resolving the installed package', async () => {
    const pkg = installedPackage(fixture());
    const augment = path.join(path.dirname(pkg.marker), 'augment.cjs');
    fs.writeFileSync(augment, "throw new Error('must not load augment as hook');\n");
    const result = await execute({
      resolvedHook: pkg.hook,
      env: { GITNEXUS_HOOK_CLI_PATH: augment },
    });
    expect(fs.existsSync(pkg.marker)).toBe(true);
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'resolves a Unix npm launcher symlink to its package',
    async () => {
      const root = fixture();
      const pkg = installedPackage(path.join(root, 'lib', 'node_modules', 'gitnexus'));
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.chmodSync(pkg.cli, 0o755);
      fs.symlinkSync(pkg.cli, path.join(bin, 'gitnexus'));
      const result = await execute({ env: { PATH: bin } });
      expect(fs.existsSync(pkg.marker)).toBe(true);
      expect(result.spawn).not.toHaveBeenCalled();
    },
  );

  it('resolves a Windows npm-prefix installation without executing the cmd shim', async () => {
    const root = fixture();
    const pkg = installedPackage(path.join(root, 'node_modules', 'gitnexus'));
    fs.writeFileSync(path.join(root, 'gitnexus.cmd'), '@echo shim\n');
    const result = await execute({ platform: 'win32', env: { PATH: root } });
    expect(fs.existsSync(pkg.marker)).toBe(true);
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it.each(['', 'true'])(
    'never falls back after an installed runtime throws (debug %s)',
    async (debug) => {
      const pkg = installedPackage(fixture(), true);
      const result = await execute({ resolvedHook: pkg.hook, env: { GITNEXUS_DEBUG: debug } });
      expect(result.spawn).not.toHaveBeenCalled();
      expect(result.stdinRead).not.toHaveBeenCalled();
      if (debug)
        expect(result.stderr).toHaveBeenCalledWith(
          expect.stringContaining('installed hook is broken'),
        );
      else expect(result.stderr).not.toHaveBeenCalled();
    },
  );

  it('does not download a replacement for a corrupt installed package manifest', async () => {
    const root = fixture();
    const pkg = installedPackage(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{broken');
    const result = await execute({ env: { GITNEXUS_HOOK_CLI_PATH: pkg.cli } });
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.stdinRead).not.toHaveBeenCalled();
    expect(fs.existsSync(pkg.marker)).toBe(false);
  });

  it('pins package fallback, forwards exact stdin bytes, and keeps payload out of argv', async () => {
    const input = Buffer.from(' {"pattern":"雪 & $(touch nope) %TEMP%"}\r\n');
    const result = await execute({ input });
    expect(result.spawn).toHaveBeenCalledExactlyOnceWith(
      'npx',
      [
        '--yes',
        '--package=gitnexus@1.7.0-rc.2',
        '--',
        process.execPath,
        launcher,
        '--package-runtime',
      ],
      {
        detached: true,
        windowsHide: true,
        env: { npm_config_loglevel: 'silent' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    expect(result.child.stdin.end).toHaveBeenCalledWith(input);
    expect(result.stdout).toHaveBeenCalledWith(Buffer.from('{"hookSpecificOutput":{}}\n'));
    expect(result.stderr).not.toHaveBeenCalled();
  });

  it('uses npm JavaScript through Node for the Windows fallback', async () => {
    const root = fixture();
    const npxJs = path.join(root, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    fs.mkdirSync(path.dirname(npxJs), { recursive: true });
    fs.writeFileSync(npxJs, '// npm entry\n');
    fs.writeFileSync(path.join(root, 'npx.cmd'), '@echo shim\n');
    const result = await execute({ platform: 'win32', env: { PATH: root } });
    expect(result.spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        npxJs,
        '--yes',
        '--package=gitnexus@1.7.0-rc.2',
        '--',
        process.execPath,
        launcher,
        '--package-runtime',
      ],
      expect.objectContaining({ detached: false, windowsHide: true }),
    );
  });

  it('uses only a constant command and validated version for the Windows cmd fallback', async () => {
    const result = await execute({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    });
    expect(result.spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        'npx.cmd --yes --package=gitnexus@1.7.0-rc.2 -- node -e "require(process.env.__GITNEXUS_HOOK_BOOTSTRAP)" -- --package-runtime',
      ],
      expect.objectContaining({
        detached: false,
        windowsHide: true,
        env: expect.objectContaining({ __GITNEXUS_HOOK_BOOTSTRAP: launcher }),
      }),
    );
    expect(result.spawn.mock.calls[0]?.[2]).not.toHaveProperty('shell');
  });

  it.each([undefined, '', 'latest', '^1.7.0', '01.7.0', '1.7.0\n', '1.7.0 & echo injected'])(
    'rejects invalid package pins: %s',
    async (version) => {
      const result = await execute({ version, env: { GITNEXUS_DEBUG: '1' } });
      expect(result.spawn).not.toHaveBeenCalled();
      expect(result.stdinRead).not.toHaveBeenCalled();
      expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining('exact package version'));
    },
  );

  it('does not emit failed npm output as hook context', async () => {
    const result = await execute({ childStatus: 1 });
    expect(result.spawn).toHaveBeenCalledOnce();
    expect(result.stdout).not.toHaveBeenCalled();
    expect(result.stderr).not.toHaveBeenCalled();
  });

  it('loads the configured installation before unrelated module or environment candidates', async () => {
    const directory = fixture();
    const configured = installedPackage(path.join(directory, 'configured'));
    const unrelated = installedPackage(path.join(directory, 'unrelated'));
    fs.writeFileSync(
      path.join(directory, 'gitnexus-hook.json'),
      JSON.stringify({ version: '1.6.12', cliPath: configured.cli }),
    );
    const result = await execute({
      directory,
      resolvedHook: unrelated.hook,
      env: { GITNEXUS_HOOK_CLI_PATH: unrelated.cli },
    });
    expect(fs.existsSync(configured.marker)).toBe(true);
    expect(fs.existsSync(unrelated.marker)).toBe(false);
    expect(result.resolve).not.toHaveBeenCalled();
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it('uses the saved package pin when the configured CLI has been uninstalled', async () => {
    const directory = fixture();
    fs.writeFileSync(
      path.join(directory, 'gitnexus-hook.json'),
      JSON.stringify({
        version: '1.6.12',
        cliPath: path.join(directory, 'deleted', 'dist', 'cli', 'index.js'),
      }),
    );
    const result = await execute({ directory, version: '9.9.9' });
    expect(result.spawn.mock.calls[0]?.[1]).toContain('--package=gitnexus@1.6.12');
  });

  it('validates the saved pin before downloading a missing installation', async () => {
    const directory = fixture();
    fs.writeFileSync(
      path.join(directory, 'gitnexus-hook.json'),
      JSON.stringify({ version: 'latest', cliPath: path.join(directory, 'deleted') }),
    );
    const result = await execute({ directory });
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it('package-runtime mode selects only npm PATH and never another configured package', async () => {
    const directory = fixture();
    const pinned = installedPackage(path.join(directory, 'node_modules', 'gitnexus'));
    const unrelated = installedPackage(path.join(directory, 'unrelated'));
    fs.writeFileSync(path.join(directory, 'gitnexus.cmd'), '@echo shim\n');
    const result = await execute({
      platform: 'win32',
      packageMode: true,
      resolvedHook: unrelated.hook,
      env: { PATH: directory, GITNEXUS_HOOK_CLI_PATH: unrelated.cli },
    });
    expect(fs.existsSync(pinned.marker)).toBe(true);
    expect(fs.existsSync(unrelated.marker)).toBe(false);
    expect(result.resolve).not.toHaveBeenCalled();
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it('package-runtime mode refuses recursive downloads when npm PATH has no hook', async () => {
    const unrelated = installedPackage(fixture());
    const result = await execute({
      packageMode: true,
      resolvedHook: unrelated.hook,
      env: { GITNEXUS_HOOK_CLI_PATH: unrelated.cli },
    });
    expect(fs.existsSync(unrelated.marker)).toBe(false);
    expect(result.resolve).not.toHaveBeenCalled();
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'signal'] as const)(
    'terminates the entire Unix install group on %s and removes handlers',
    async (cancel) => {
      const result = await execute({ cancel });
      expect(result.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(result.kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(result.stdout).not.toHaveBeenCalled();
      expect(result.timers.size).toBe(0);
      expect(result.processEvents.listenerCount('SIGTERM')).toBe(0);
      expect(result.processEvents.listenerCount('SIGINT')).toBe(0);
    },
  );

  it('escalates a SIGTERM-resistant install group and closes its pipes', async () => {
    const result = await execute({ cancel: 'timeout', ignoreTermination: true });
    expect(result.kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(result.child.stdout.destroy).toHaveBeenCalledOnce();
    expect(result.child.stderr.destroy).toHaveBeenCalledOnce();
    expect(result.child.stdin.destroy).toHaveBeenCalledOnce();
    expect(result.child.unref).toHaveBeenCalledOnce();
    expect(result.timers.size).toBe(0);
  });

  it('terminates the Windows npm process tree without a shell', async () => {
    const result = await execute({ platform: 'win32', cancel: 'signal' });
    expect(result.spawnSync).toHaveBeenCalledWith(
      path.join('C:\\Windows', 'System32', 'taskkill.exe'),
      ['/pid', '4242', '/T', '/F'],
      { timeout: 5000, windowsHide: true, stdio: 'ignore' },
    );
    expect(result.kill).not.toHaveBeenCalled();
  });

  it('skips a concurrent cold install without spawning or consuming stdin', async () => {
    const result = await execute({ lockOwner: 'live' });
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.stdinRead).not.toHaveBeenCalled();
    expect(fs.existsSync(result.lock)).toBe(true);
    expect(result.stdout).not.toHaveBeenCalled();
    expect(result.stderr).not.toHaveBeenCalled();
  });

  it('reclaims an install slot whose owner died and releases it after completion', async () => {
    const result = await execute({ lockOwner: 'dead' });
    expect(result.kill).toHaveBeenCalledWith(99999, 0);
    expect(result.spawn).toHaveBeenCalledOnce();
    expect(fs.existsSync(result.lock)).toBe(false);
  });

  it('releases the install slot after process-tree cleanup', async () => {
    const result = await execute({ cancel: 'signal' });
    expect(result.kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(fs.existsSync(result.lock)).toBe(false);
  });

  it('recovers an interrupted reclaim that left an empty lock directory', async () => {
    const result = await execute({ lockOwner: 'empty' });
    expect(result.spawn).toHaveBeenCalledOnce();
    expect(fs.existsSync(result.lock)).toBe(false);
  });

  it('does not let a delayed stale reclaimer remove a replacement owner', () => {
    const directory = fixture();
    const packageName = 'gitnexus@1.7.0-rc.2';
    const key = createHash('sha256')
      .update(`${os.homedir()}\0${packageName}`)
      .digest('hex')
      .slice(0, 24);
    const lock = path.join(directory, `gitnexus-hook-install-${key}.lock`);
    const oldOwner = path.join(lock, '99999-00000000.owner');
    fs.mkdirSync(lock);
    fs.writeFileSync(oldOwner, '');
    type Acquire = (name: string) => (() => void) | null;
    function loadAcquire(unlinkSync: typeof fs.unlinkSync): Acquire {
      return vm.runInNewContext(
        source.slice(0, source.lastIndexOf('\nmain().catch')) + '\nacquireInstallSlot;',
        {
          require: (id: string) =>
            id === 'fs'
              ? { ...fs, unlinkSync }
              : id === 'os'
                ? { ...os, tmpdir: () => directory }
                : realRequire(id),
          process: {
            pid: process.pid,
            kill: (pid: number) => {
              if (pid === 99999) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
            },
          },
        },
      );
    }
    const acquireFirst = loadAcquire(fs.unlinkSync);
    let releaseFirst: (() => void) | null = null;
    const acquireDelayed = loadAcquire((target) => {
      // Both reclaimers have inspected the dead owner. The first publishes
      // its new lock immediately before the delayed contender tries unlink.
      if (String(target) === oldOwner) releaseFirst = acquireFirst(packageName);
      fs.unlinkSync(target);
    });
    expect(acquireDelayed(packageName)).toBeNull();
    expect(releaseFirst).toBeTypeOf('function');
    const current = fs.readdirSync(lock);
    expect(current).toHaveLength(1);
    expect(current[0]).not.toBe(path.basename(oldOwner));
    (releaseFirst as (() => void) | null)?.();
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('published-package fallback', () => {
  it.each(['plugin', 'installed'] as const)(
    'executes an old package exposing only the gitnexus bin from the %s launcher',
    (kind) => {
      const root = fixture();
      const hooks = path.join(root, 'hooks');
      const npmPrefix = path.join(root, 'npm');
      const cache = path.join(root, 'cache', 'node_modules');
      const bin = path.join(cache, '.bin');
      fs.mkdirSync(hooks);
      fs.mkdirSync(npmPrefix);
      fs.mkdirSync(bin, { recursive: true });
      const pkg = installedPackage(path.join(cache, 'gitnexus'));
      fs.writeFileSync(
        path.join(cache, 'gitnexus', 'package.json'),
        JSON.stringify({
          name: 'gitnexus',
          version: '1.6.12',
          bin: { gitnexus: 'dist/cli/index.js' },
        }),
      );
      fs.writeFileSync(
        pkg.hook,
        "const fs = require('fs'); process.stdout.write(JSON.stringify({version:'1.6.12', input:fs.readFileSync(0).toString('base64')}));\n",
      );
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(bin, 'gitnexus.cmd'), '@echo shim\n');
      } else {
        fs.chmodSync(pkg.cli, 0o755);
        fs.symlinkSync(pkg.cli, path.join(bin, 'gitnexus'));
      }
      const entry = path.join(hooks, 'gitnexus-hook.cjs');
      fs.writeFileSync(entry, source);
      if (kind === 'installed') {
        fs.writeFileSync(
          path.join(hooks, 'gitnexus-hook.json'),
          JSON.stringify({
            version: '1.6.12',
            cliPath: path.join(root, 'uninstalled', 'dist', 'cli', 'index.js'),
          }),
        );
      } else {
        fs.mkdirSync(path.join(root, '.claude-plugin'));
        fs.writeFileSync(
          path.join(root, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ version: '1.6.12' }),
        );
      }
      const log = path.join(root, 'npm-args.jsonl');
      const npmSource = `const fs = require('fs'); const {spawnSync} = require('child_process');
const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const separator = args.indexOf('--');
const child = spawnSync(args[separator + 1], args.slice(separator + 2), {
  input: fs.readFileSync(0), windowsHide: true,
  env: {...process.env, PATH: ${JSON.stringify(bin)} + require('path').delimiter + process.env.PATH}
});
if (child.error) throw child.error;
process.stdout.write(child.stdout); process.stderr.write(child.stderr); process.exitCode = child.status ?? 1;
`;
      if (process.platform === 'win32') {
        const npmJs = path.join(npmPrefix, 'node_modules', 'npm', 'bin', 'npx-cli.js');
        fs.mkdirSync(path.dirname(npmJs), { recursive: true });
        fs.writeFileSync(npmJs, npmSource);
        fs.writeFileSync(path.join(npmPrefix, 'npx.cmd'), '@echo shim\n');
      } else {
        fs.writeFileSync(path.join(npmPrefix, 'npx'), `#!${process.execPath}\n${npmSource}`, {
          mode: 0o755,
        });
      }
      const input = Buffer.from(' {"pattern":"雪 & $(touch nope)"}\r\n');
      const result = realSpawnSync(process.execPath, [entry], {
        input,
        cwd: root,
        env: {
          ...process.env,
          PATH: npmPrefix,
          NODE_PATH: '',
          GITNEXUS_HOOK_CLI_PATH: undefined,
          GITNEXUS_DEBUG: '1',
        },
        timeout: 10000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, String(result.stderr)).toBe(0);
      expect(JSON.parse(String(result.stdout))).toEqual({
        version: '1.6.12',
        input: input.toString('base64'),
      });
      const invocations = fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(invocations).toEqual([
        ['--yes', '--package=gitnexus@1.6.12', '--', process.execPath, entry, '--package-runtime'],
      ]);
    },
  );
});
