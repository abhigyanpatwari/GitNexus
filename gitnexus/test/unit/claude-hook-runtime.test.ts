import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { runHook } from '../utils/hook-test-helpers.js';

const HOOK_DIR = path.resolve(__dirname, '../../hooks/claude');
const PLUGIN_DIR = path.resolve(__dirname, '../../../gitnexus-claude-plugin/hooks');
const RUNTIME = path.join(HOOK_DIR, 'claude-hook-runtime.cjs');

interface CliTarget {
  command: string;
  args: string[];
  npx?: boolean;
}

interface HookRuntime {
  runGitNexusCli: (target: CliTarget, args: string[], cwd: string, timeout: number) => unknown;
}

function loadRuntime(
  options: { platform?: string; guard?: string | null; legacyProbe?: boolean } = {},
) {
  const result = { status: 0, stderr: '[GitNexus] context', stdout: '' };
  const spawnSync = vi.fn(() => result);
  const resolveGuard = vi.fn(() => options.guard ?? null);
  const require = createRequire(RUNTIME);
  const module = { exports: {} as HookRuntime };
  vm.runInNewContext(fs.readFileSync(RUNTIME, 'utf8'), {
    module,
    require: (id: string) => {
      if (id === 'child_process') return { spawnSync };
      if (id === './hook-db-lock-probe.cjs') {
        return options.legacyProbe ? {} : { resolveUnixGuardTimeout: resolveGuard };
      }
      return require(id);
    },
    process: { platform: options.platform ?? 'linux', env: {}, stderr: { write: vi.fn() } },
  });
  return { ...module.exports, spawnSync, resolveGuard, result };
}

describe('shared Claude hook CLI execution', () => {
  it('guards direct targets once and preserves executable prefixes and literal arguments', () => {
    const runtime = loadRuntime({ guard: '/tools/timeout' });
    const target = { command: '/node path/node', args: ['/cli path/index.js'] };
    const args = ['augment', '--', '$(touch unwanted); `echo nope`'];

    expect(runtime.runGitNexusCli(target, args, '/repo path', 7000)).toBe(runtime.result);
    expect(runtime.spawnSync).toHaveBeenCalledExactlyOnceWith(
      '/tools/timeout',
      ['-k', '1', '8', target.command, ...target.args, ...args],
      {
        encoding: 'utf-8',
        timeout: 7000,
        cwd: '/repo path',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    expect(target.args).toEqual(['/cli path/index.js']);
  });

  it('gives npx its extra budget and kills the whole child process group', () => {
    const runtime = loadRuntime({ guard: '/tools/timeout' });
    runtime.runGitNexusCli(
      { command: 'npx', args: ['-y', 'gitnexus'], npx: true },
      ['augment'],
      '/repo',
      7000,
    );

    expect(runtime.spawnSync).toHaveBeenCalledExactlyOnceWith(
      '/tools/timeout',
      ['-s', 'KILL', '-k', '1', '13', 'npx', '-y', 'gitnexus', 'augment'],
      expect.objectContaining({ timeout: 12000, windowsHide: true }),
    );
  });

  it.each([
    { command: 'gitnexus.cmd', args: [], timeout: 7000 },
    { command: 'npx.cmd', args: ['-y', 'gitnexus'], npx: true, timeout: 12000 },
  ])('runs $command without a Unix probe or shell on Windows', (target) => {
    const runtime = loadRuntime({ platform: 'win32', guard: '/tools/timeout' });
    runtime.runGitNexusCli(target, ['augment', '--', '&literal'], 'C:\\repo', 7000);

    expect(runtime.resolveGuard).not.toHaveBeenCalled();
    expect(runtime.spawnSync).toHaveBeenCalledExactlyOnceWith(
      target.command,
      [...target.args, 'augment', '--', '&literal'],
      {
        encoding: 'utf-8',
        timeout: target.timeout,
        cwd: 'C:\\repo',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
  });

  it.each([false, true])(
    'executes without an unavailable guard (legacy probe: %s)',
    (legacyProbe) => {
      const runtime = loadRuntime({ legacyProbe });
      runtime.runGitNexusCli({ command: 'gitnexus', args: [] }, ['augment'], '/repo', 7000);
      expect(runtime.spawnSync).toHaveBeenCalledExactlyOnceWith(
        'gitnexus',
        ['augment'],
        expect.objectContaining({ timeout: 7000 }),
      );
    },
  );
});

describe('Claude hook package ownership', () => {
  it('ships only the loader and hook manifest in the standalone plugin', () => {
    expect(fs.readdirSync(PLUGIN_DIR).sort()).toEqual(['gitnexus-hook.js', 'hooks.json']);
  });

  it('loads one isolated installed package through both entrypoints and returns identical context', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-isolation-'));
    try {
      const repo = path.join(temp, 'repo');
      const storagePath = path.join(repo, '.gitnexus');
      const home = path.join(temp, 'registry');
      fs.mkdirSync(storagePath, { recursive: true });
      fs.mkdirSync(home);
      fs.writeFileSync(
        path.join(storagePath, 'gitnexus.json'),
        JSON.stringify({ repoPath: repo, storagePath }),
      );
      fs.writeFileSync(
        path.join(home, 'registry.json'),
        JSON.stringify([{ name: 'isolated', path: repo, storagePath }]),
      );
      const cli = path.join(temp, 'fake-cli.cjs');
      fs.writeFileSync(
        cli,
        "process.stderr.write('diagnostic prefix\\n[GitNexus] ' + JSON.stringify(process.argv.slice(2)));\n",
      );
      const modules = path.join(temp, 'installation', 'node_modules');
      const packageRoot = path.join(modules, 'gitnexus');
      const packageHooks = path.join(packageRoot, 'hooks', 'claude');
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        '{"name":"gitnexus","type":"module"}\n',
      );
      fs.cpSync(HOOK_DIR, packageHooks, { recursive: true });
      const standalonePlugin = path.join(temp, 'standalone-plugin');
      fs.cpSync(PLUGIN_DIR, standalonePlugin, { recursive: true });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GITNEXUS_HOME: home,
        GITNEXUS_HOOK_CLI_PATH: cli,
        GITNEXUS_HOOK_TIMEOUT_PATH: 'disabled',
        GITNEXUS_DEBUG: '',
        GITNEXUS_STORAGE_PATH: undefined,
        GITNEXUS_STORAGE_ROOT: undefined,
        NODE_PATH: modules,
      };
      const input = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'shared runtime' },
        cwd: repo,
      };
      const results = [
        path.join(packageHooks, 'gitnexus-hook.cjs'),
        path.join(standalonePlugin, 'gitnexus-hook.js'),
      ].map((entry) => runHook(entry, input, repo, { env }));

      for (const result of results) {
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: '[GitNexus] ["augment","--","shared runtime"]',
          },
        });
      }
      expect(results[0]).toEqual(results[1]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
