import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { GitNexusPlugin } from '../../hooks/opencode/gitnexus-plugin.js';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

async function invoke(tool: string, args: unknown, value: unknown = 'hits') {
  const hooks = await GitNexusPlugin({ directory: '/repo' });
  const output = { output: value };
  await hooks['tool.execute.after']({ tool, args }, output);
  return output.output;
}

beforeEach(() => {
  vi.stubEnv('GITNEXUS_HOOK_CLI_PATH', '');
  execFileMock.mockReset();
  execFileMock.mockImplementation(
    (_cmd: string, argv: string[], _options: unknown, callback: Callback) => {
      callback(
        null,
        argv.includes('status') ? '{"status":"up-to-date"}' : '',
        '[GitNexus] callers: A',
      );
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', platform);
});

describe('search augmentation through the public hook', () => {
  it.each([
    ['grep', { pattern: 'UserService' }, 'UserService'],
    ['grep', { query: 'fallback' }, 'fallback'],
    ['glob', { pattern: '**/UserService*' }, 'UserService'],
    ['glob', { pattern: 'src/**/*.ts' }, 'src'],
    ['glob', { pattern: '**/*.service.ts' }, 'service'],
    ['bash', { command: 'rg --type ts UserService .' }, 'UserService'],
    ['bash', { command: 'grep -r UserService .' }, 'UserService'],
    ['bash', { command: 'rg -n -e UserService setup.ts' }, 'UserService'],
    ['bash', { command: 'rg --regexp UserService .' }, 'UserService'],
    ['bash', { command: 'grep --expression UserService .' }, 'UserService'],
    ['bash', { command: 'rg "foo bar" .' }, 'foo bar'],
    ['bash', { command: "grep -r 'user service' src" }, 'user service'],
    ['bash', { command: 'rg -e "foo bar" file.ts' }, 'foo bar'],
    ['bash', { command: 'rg --max-columns 100 UserService .' }, 'UserService'],
    ['bash', { command: 'rg --max-columns=100 UserService .' }, 'UserService'],
    ['bash', { command: 'rg -M 100 UserService .' }, 'UserService'],
    ['bash', { command: 'rg -- -foobar file.ts' }, '-foobar'],
    ['bash', { command: 'grep -- -foobar file.ts' }, '-foobar'],
    ['bash', { command: '/usr/bin/rg UserService .' }, 'UserService'],
    ['bash', { command: 'rg "foo;bar" file.ts | head' }, 'foo;bar'],
    ['bash', { command: 'rg UserService . && echo done' }, 'UserService'],
    ['bash', { command: 'rg --regexp=UserService .' }, 'UserService'],
    ['bash', { command: 'rg -eUserService .' }, 'UserService'],
    ['bash', { command: 'rg src -e UserService' }, 'UserService'],
    ['bash', { command: 'rg foo\\ bar src' }, 'foo bar'],
    ['bash', { command: 'rg "foo\\\"bar" src' }, 'foo"bar'],
    ['bash', { command: 'rg "foo\\dbar" src' }, 'foo\\dbar'],
    ['bash', { command: "rg '$literal' src" }, '$literal'],
    ['bash', { command: 'rg UserService # comment' }, 'UserService'],
    ['bash', { command: 'rg \\\nUserService src' }, 'UserService'],
  ])('augments %s %j with %s', async (tool, args, pattern) => {
    expect(await invoke(tool, args)).toBe('hits\n\n[GitNexus] callers: A');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1].slice(-3)).toEqual(['augment', '--', pattern]);
    expect(execFileMock.mock.calls[0][2]).toMatchObject({
      cwd: '/repo',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
  });

  it.each([
    ['grep', { pattern: 'ab' }],
    ['grep', {}],
    ['grep', null],
    ['grep', 'UserService'],
    ['glob', { pattern: '**/*.{a,b}' }],
    ['glob', {}],
    ['bash', { command: 'rg -n "ab" .' }],
    ['bash', { command: 'npm test' }],
    ['bash', { command: 'echo rg UserService' }],
    ['bash', { command: 'printf "rg UserService"' }],
    ['bash', { command: 'rg -f patterns.txt src' }],
    ['bash', { command: 'rg --file patterns.txt src' }],
    ['bash', { command: 'rg --file=patterns.txt src' }],
    ['bash', { command: 'rg -fpatterns.txt src' }],
    ['bash', { command: 'rg src -f patterns.txt' }],
    ['bash', { command: 'rg --files src' }],
    ['bash', { command: 'rg -n; echo UserService' }],
    ['bash', { command: 'rg -n\necho UserService' }],
    ['bash', { command: 'rg "" src' }],
    ['bash', { command: 'rg "UserService src' }],
    ['bash', { command: 'rg $pattern src' }],
    ['bash', { command: 'rg "${pattern}" src' }],
    ['bash', { command: 'rg `query` src' }],
    ['bash', { command: 'rg UserService\\' }],
    ['bash', { command: 'rg -n # UserService' }],
    ['bash', { command: null }],
    ['bash', {}],
    ['read', { filePath: 'a.ts' }],
    ['edit', { filePath: 'a.ts' }],
  ])('leaves %s %j untouched', async (tool, args) => {
    expect(await invoke(tool, args)).toBe('hits');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('strips diagnostics before the context marker and handles an empty tool result', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _argv: string[], _options: unknown, callback: Callback) =>
        callback(null, '', 'diagnostic\n[GitNexus] callers: A\n'),
    );
    expect(await invoke('grep', { pattern: 'UserService' }, '')).toBe('[GitNexus] callers: A');
  });

  it('discards unmarked diagnostics and never coerces structured results', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _argv: string[], _options: unknown, callback: Callback) =>
        callback(null, '', 'diagnostic'),
    );
    expect(await invoke('grep', { pattern: 'UserService' })).toBe('hits');
    expect(await invoke('grep', { pattern: 'UserService' }, { structured: true })).toEqual({
      structured: true,
    });
  });
});

describe('stale-index hints', () => {
  it.each([
    'git commit -m x',
    'git merge main',
    'git rebase main',
    'git cherry-pick abc',
    'git pull',
    'cd src && git commit -m x',
    'npm test || git pull',
    'git status\ngit commit -m x',
    'git status\r\ngit merge main',
  ])('checks %s', async (command) => {
    execFileMock.mockImplementation(
      (_cmd: string, _argv: string[], _options: unknown, callback: Callback) =>
        callback(null, '{"status":"stale","index":{"commit":"abc1234567"}}', ''),
    );
    expect(await invoke('bash', { command })).toBe(
      'hits\n\n[GitNexus] GitNexus index is stale (last indexed: abc1234). Run `gitnexus analyze` to update the knowledge graph.',
    );
    expect(execFileMock.mock.calls[0][1].slice(-2)).toEqual(['status', '--json']);
    expect(execFileMock.mock.calls[0][2]).toMatchObject({ timeout: 15000 });
  });

  it.each([
    'git status',
    'git diff',
    'git stash push',
    "echo 'git commit'",
    "grep 'git commit' file.txt",
    'cat notes.md | grep git-pull',
  ])('does not check %s', async (command) => {
    await invoke('bash', { command });
    expect(execFileMock.mock.calls.filter((call) => call[1].includes('status'))).toEqual([]);
  });

  it.each(['{"status":"up-to-date"}', '{"error":"not-indexed"}', 'not json', '', 'null'])(
    'stays silent for %s',
    async (stdout) => {
      execFileMock.mockImplementation(
        (_cmd: string, _argv: string[], _options: unknown, callback: Callback) =>
          callback(null, stdout, ''),
      );
      expect(await invoke('bash', { command: 'git commit -m x' })).toBe('hits');
    },
  );
});

describe('CLI boundaries', () => {
  it('uses the CLI override with an interpreter, never the OpenCode host binary', async () => {
    vi.stubEnv('GITNEXUS_HOOK_CLI_PATH', '/custom/cli.js');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    await invoke('grep', { pattern: 'UserService' });
    expect(execFileMock.mock.calls[0].slice(0, 2)).toEqual([
      'node',
      ['/custom/cli.js', 'augment', '--', 'UserService'],
    ]);
    expect(execFileMock.mock.calls[0][2].shell).toBeUndefined();
  });

  it.each([
    'foo & calc',
    'foo|bar',
    'a > b',
    'a < b',
    'x^&y',
    'a"b',
    "a'b",
    'a`b',
    'a$b',
    'a;b',
    'a(b)',
    'a%PATH%',
    'a\nb',
    'a\rb',
  ])('drops unsafe Windows shell input %s', async (pattern) => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(await invoke('grep', { pattern })).toBe('hits');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('quotes multi-word Windows PATH fallback arguments', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await invoke('grep', { pattern: 'User Service' });
    expect(execFileMock.mock.calls[0].slice(0, 2)).toEqual([
      'gitnexus',
      ['augment', '--', '"User Service"'],
    ]);
    expect(execFileMock.mock.calls[0][2].shell).toBe(true);
  });

  it('passes metacharacters literally without a shell when the CLI file exists', async () => {
    vi.stubEnv('GITNEXUS_HOOK_CLI_PATH', '/custom/cli.js');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    await invoke('grep', { pattern: 'foo & calc' });
    expect(execFileMock.mock.calls[0][1].slice(-3)).toEqual(['augment', '--', 'foo & calc']);
    expect(execFileMock.mock.calls[0][2].shell).toBeUndefined();
  });

  it.each(['timeout', 'nonzero exit', 'buffer exceeded'])(
    'preserves output after %s',
    async (reason) => {
      execFileMock.mockImplementation(
        (_cmd: string, _argv: string[], _options: unknown, callback: Callback) =>
          callback(new Error(reason), '', '[GitNexus] incomplete'),
      );
      expect(await invoke('grep', { pattern: 'UserService' })).toBe('hits');
      expect(await invoke('bash', { command: 'git commit -m x' })).toBe('hits');
    },
  );

  it('never throws for a synchronous spawn error or malformed hook arguments', async () => {
    execFileMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    expect(await invoke('grep', { pattern: 'UserService' })).toBe('hits');
    const hooks = await GitNexusPlugin();
    await expect(hooks['tool.execute.after'](null, null)).resolves.toBeUndefined();
  });
});
