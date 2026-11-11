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
  extractPattern: (
    toolName: string,
    toolInput: { command?: string; pattern?: string },
  ) => string | null;
}

function loadRuntime(options: { platform?: string; guard?: string | null } = {}) {
  const result = { status: 0, stderr: '[GitNexus] context', stdout: '' };
  const spawnSync = vi.fn(() => result);
  const resolveGuard = vi.fn(() => options.guard ?? null);
  const require = createRequire(RUNTIME);
  const module = { exports: {} as HookRuntime };
  vm.runInNewContext(
    fs.readFileSync(RUNTIME, 'utf8') + '\nmodule.exports.extractPattern = extractPattern;',
    {
      module,
      require: (id: string) => {
        if (id === 'child_process') return { spawnSync };
        if (id === './hook-db-lock-probe.cjs') {
          return { resolveUnixGuardTimeout: resolveGuard };
        }
        return require(id);
      },
      process: { platform: options.platform ?? 'linux', env: {}, stderr: { write: vi.fn() } },
    },
  );
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

  it.each(['C:\\nodejs\\node.exe', 'C:\\Program Files\\nodejs\\node.exe'])(
    'passes the packaged CLI to %s without a Unix guard on Windows',
    (command) => {
      const runtime = loadRuntime({ platform: 'win32', guard: '/tools/timeout' });
      const target = { command, args: ['C:\\gitnexus package\\dist\\cli\\index.js'] };
      runtime.runGitNexusCli(target, ['augment', '--', '&literal'], 'C:\\repo', 7000);

      expect(runtime.resolveGuard).not.toHaveBeenCalled();
      expect(runtime.spawnSync).toHaveBeenCalledExactlyOnceWith(
        target.command,
        [...target.args, 'augment', '--', '&literal'],
        {
          encoding: 'utf-8',
          timeout: 7000,
          cwd: 'C:\\repo',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    },
  );

  it('executes directly when the packaged probe finds no usable guard', () => {
    const runtime = loadRuntime();
    runtime.runGitNexusCli({ command: 'gitnexus', args: [] }, ['augment'], '/repo', 7000);
    expect(runtime.resolveGuard).toHaveBeenCalledOnce();
    expect(runtime.spawnSync).toHaveBeenCalledExactlyOnceWith(
      'gitnexus',
      ['augment'],
      expect.objectContaining({ timeout: 7000 }),
    );
  });
});

describe('Claude hook literal Bash search patterns', () => {
  it.each([
    { command: "rg 'database busy' src", pattern: 'database busy' },
    { command: 'grep -n "database busy" src', pattern: 'database busy' },
    { command: String.raw`rg database\ busy src`, pattern: 'database busy' },
    { command: `rg 'say "hello"' src`, pattern: 'say "hello"' },
    { command: `grep "user's table" src`, pattern: "user's table" },
    { command: String.raw`rg "say \"hello\"" src`, pattern: 'say "hello"' },
    { command: String.raw`rg 'can'\''t connect' src`, pattern: "can't connect" },
    { command: String.raw`rg "\bworker\s+queue\b" src`, pattern: String.raw`\bworker\s+queue\b` },
    { command: String.raw`rg "path\\name" src`, pattern: String.raw`path\name` },
    { command: String.raw`rg "\$literal" src`, pattern: '$literal' },
    { command: "rg '$HOME literal' src", pattern: '$HOME literal' },
    { command: 'rg "queue$" src', pattern: 'queue$' },
    { command: `rg pre" middle "'suffix' src`, pattern: 'pre middle suffix' },
    { command: "rg -g '*.ts' -n 'quoted phrase' src", pattern: 'quoted phrase' },
    { command: "rg -e 'explicit phrase' src", pattern: 'explicit phrase' },
    { command: 'grep --regexp "explicit phrase" src', pattern: 'explicit phrase' },
    { command: "rg --regexp='explicit phrase' src", pattern: 'explicit phrase' },
    { command: 'grep -e"explicit phrase" src', pattern: 'explicit phrase' },
    { command: "rg -- '-literal phrase' src", pattern: '-literal phrase' },
    { command: "grep -n -- 'quoted phrase' src", pattern: 'quoted phrase' },
  ])('preserves the complete argument in $command', ({ command, pattern }) => {
    expect(loadRuntime().extractPattern('Bash', { command })).toBe(pattern);
  });

  it.each([
    "rg '' src",
    'grep "" src',
    "rg -e '' src",
    'grep --regexp="" src',
    "rg 'unclosed phrase",
    'grep "unclosed phrase',
    'rg dangling\\',
    'rg "partial $QUERY" src',
    'grep "partial ${QUERY}" src',
    'rg "partial $(printf phrase)" src',
    'rg "partial `printf phrase`" src',
    'rg partial$QUERY src',
    'rg "valid phrase" "unclosed path',
  ])('declines an empty, malformed, or expanded argument in %s', (command) => {
    expect(loadRuntime().extractPattern('Bash', { command })).toBeNull();
  });
});

describe('Claude hook package ownership', () => {
  it('ships only the loader and hook manifest in the standalone plugin', () => {
    expect(fs.readdirSync(PLUGIN_DIR).sort()).toEqual(['gitnexus-hook.js', 'hooks.json']);
  });

  it.each([false, true])(
    'skips a missing packaged CLI without npx or another package (resolvable package: %s)',
    (otherPackageAvailable) => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-missing-cli-'));
      try {
        const repo = path.join(temp, 'repo');
        const storagePath = path.join(repo, '.gitnexus');
        const home = path.join(temp, 'home');
        const bin = path.join(temp, 'bin');
        const modules = path.join(temp, 'other-installation', 'node_modules');
        const packageHooks = path.join(temp, 'package', 'hooks', 'claude');
        const marker = path.join(temp, 'unexpected-cli');
        fs.mkdirSync(storagePath, { recursive: true });
        fs.mkdirSync(home);
        fs.mkdirSync(bin);
        fs.writeFileSync(
          path.join(storagePath, 'gitnexus.json'),
          JSON.stringify({ repoPath: repo, storagePath }),
        );
        fs.cpSync(HOOK_DIR, packageHooks, { recursive: true });
        const trapCli = path.join(temp, 'unexpected-cli.cjs');
        const trapSource = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`;
        fs.writeFileSync(trapCli, trapSource);
        fs.writeFileSync(path.join(bin, 'npx'), `#!/usr/bin/env node\n${trapSource}`, {
          mode: 0o755,
        });
        fs.writeFileSync(path.join(bin, 'npx.cmd'), `@"${process.execPath}" "${trapCli}"\r\n`);
        if (otherPackageAvailable) {
          const otherCliDir = path.join(modules, 'gitnexus', 'dist', 'cli');
          fs.mkdirSync(otherCliDir, { recursive: true });
          fs.writeFileSync(path.join(otherCliDir, 'index.js'), trapSource);
        }
        const input = {
          hook_event_name: 'PreToolUse',
          tool_name: 'Grep',
          tool_input: { pattern: 'missing package cli' },
          cwd: repo,
        };
        for (const debug of ['', '1']) {
          const result = runHook(path.join(packageHooks, 'gitnexus-hook.cjs'), input, repo, {
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
              NODE_PATH: otherPackageAvailable ? modules : '',
              GITNEXUS_HOME: home,
              GITNEXUS_HOOK_CLI_PATH: '',
              GITNEXUS_DEBUG: debug,
              GITNEXUS_STORAGE_PATH: undefined,
              GITNEXUS_STORAGE_ROOT: undefined,
            },
          });
          expect(result.status).toBe(0);
          expect(result.stdout).toBe('');
          expect(result.stderr).toBe(
            debug ? '[GitNexus] augment skipped: packaged CLI is unavailable\n' : '',
          );
          expect(fs.existsSync(marker)).toBe(false);
        }
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  );

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
        '{"name":"gitnexus","version":"1.6.12","type":"module"}\n',
      );
      fs.cpSync(HOOK_DIR, packageHooks, { recursive: true });
      const packagedCliDir = path.join(packageRoot, 'dist', 'cli');
      fs.mkdirSync(packagedCliDir, { recursive: true });
      fs.writeFileSync(
        path.join(packagedCliDir, 'index.js'),
        "process.stderr.write('[GitNexus] packaged CLI must not override explicit path');\n",
      );
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
      for (const search of [
        { tool_name: 'Grep', tool_input: { pattern: 'shared runtime' } },
        { tool_name: 'Bash', tool_input: { command: 'rg "shared runtime" src' } },
      ]) {
        const input = { hook_event_name: 'PreToolUse', ...search, cwd: repo };
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
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
