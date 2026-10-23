/**
 * Unit tests for the OpenCode hooks plugin
 * (`hooks/opencode/gitnexus-plugin.js`).
 *
 * Covers:
 * - extractOpenCodePattern: grep/glob/bash pattern extraction
 * - extractBashSearchPattern: rg/grep argv parsing
 * - isGitMutationCommand: git mutation detection
 * - extractAugmentContext / parseStatusPayload: CLI output parsing
 * - resolveCliInvocation: env override vs PATH fallback
 * - createAfterHook: appends augment context + stale hint, never throws
 * - GitNexusPlugin: exports the `tool.execute.after` hook
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const spawnSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import {
  GitNexusPlugin,
  checkIndexStale,
  createAfterHook,
  extractAugmentContext,
  extractBashSearchPattern,
  extractOpenCodePattern,
  isGitMutationCommand,
  isShellMetaUnsafe,
  parseStatusPayload,
  resolveCliInvocation,
  runAugment,
  shouldSkipAugmentForShell,
} from '../../hooks/opencode/gitnexus-plugin.js';

describe('extractOpenCodePattern', () => {
  it('extracts grep patterns of length >= 3', () => {
    expect(extractOpenCodePattern('grep', { pattern: 'UserService' })).toBe('UserService');
    expect(extractOpenCodePattern('grep', { pattern: 'ab' })).toBeNull();
    expect(extractOpenCodePattern('grep', { query: 'fallback' })).toBe('fallback');
    expect(extractOpenCodePattern('grep', {})).toBeNull();
  });

  it('derives a token from glob patterns', () => {
    expect(extractOpenCodePattern('glob', { pattern: '**/UserService*' })).toBe('UserService');
    expect(extractOpenCodePattern('glob', { pattern: 'src/**/*.ts' })).toBe('src');
    expect(extractOpenCodePattern('glob', { pattern: '**/*.service.ts' })).toBe('service');
    expect(extractOpenCodePattern('glob', { pattern: '**/*.{a,b}' })).toBeNull();
    expect(extractOpenCodePattern('glob', {})).toBeNull();
  });

  it('parses rg/grep out of bash commands only', () => {
    expect(extractOpenCodePattern('bash', { command: 'rg -n "UserService" src' })).toBe(
      'UserService',
    );
    expect(extractOpenCodePattern('bash', { command: 'ls -la' })).toBeNull();
    expect(extractOpenCodePattern('bash', {})).toBeNull();
  });

  it('ignores non-search tools and malformed args', () => {
    expect(extractOpenCodePattern('read', { filePath: 'a.ts' })).toBeNull();
    expect(extractOpenCodePattern('edit', { filePath: 'a.ts' })).toBeNull();
    expect(extractOpenCodePattern('grep', null)).toBeNull();
    expect(extractOpenCodePattern('grep', 'UserService')).toBeNull();
  });
});

describe('extractBashSearchPattern', () => {
  it('skips flags that consume a value', () => {
    expect(extractBashSearchPattern('rg --type ts UserService .')).toBe('UserService');
    expect(extractBashSearchPattern('grep -r UserService .')).toBe('UserService');
  });

  it('treats -e/--regexp/--expression as the pattern itself, not a value to skip', () => {
    expect(extractBashSearchPattern('rg -e UserService .')).toBe('UserService');
    expect(extractBashSearchPattern('grep -e UserService file.ts')).toBe('UserService');
    expect(extractBashSearchPattern('rg --regexp UserService .')).toBe('UserService');
    // The pattern flag must still win over a following positional filename.
    expect(extractBashSearchPattern('rg -n -e UserService setup.ts')).toBe('UserService');
  });

  it('keeps quoted multi-word phrases intact instead of truncating at the space', () => {
    expect(extractBashSearchPattern('rg "foo bar" .')).toBe('foo bar');
    expect(extractBashSearchPattern("grep -r 'user service' src")).toBe('user service');
    expect(extractBashSearchPattern('rg -e "foo bar" file.ts')).toBe('foo bar');
  });

  it('rejects short tokens and non-search commands', () => {
    expect(extractBashSearchPattern('rg -n "ab" .')).toBeNull();
    expect(extractBashSearchPattern('npm test')).toBeNull();
    expect(extractBashSearchPattern(null)).toBeNull();
  });
});

describe('isGitMutationCommand', () => {
  it.each([
    'git commit -m x',
    'git merge main',
    'git rebase main',
    'git cherry-pick abc',
    'git pull',
    'cd src && git commit -m x',
    'npm test || git pull',
  ])('detects %s', (cmd) => expect(isGitMutationCommand(cmd)).toBe(true));

  it.each([
    'git status',
    'git diff',
    'git stash push',
    'npm test',
    '',
    // Text that merely mentions a mutation must not count.
    "echo 'git commit'",
    "grep 'git commit' file.txt",
    'cat notes.md | grep git-pull',
  ])('ignores %s', (cmd) => expect(isGitMutationCommand(cmd)).toBe(false));

  it('rejects non-strings', () => {
    expect(isGitMutationCommand(null)).toBe(false);
    expect(isGitMutationCommand(undefined)).toBe(false);
  });
});

describe('extractAugmentContext', () => {
  it('keeps only the marked payload', () => {
    expect(extractAugmentContext('noise\n[GitNexus] callers: A')).toBe('[GitNexus] callers: A');
  });

  it('returns empty when the marker is absent', () => {
    expect(extractAugmentContext('just diagnostics')).toBe('');
    expect(extractAugmentContext('')).toBe('');
  });
});

describe('parseStatusPayload', () => {
  it('parses status JSON', () => {
    const payload = parseStatusPayload(
      JSON.stringify({ schemaVersion: 1, status: 'stale', index: { commit: 'abc1234' } }),
    );
    expect(payload?.status).toBe('stale');
  });

  it('returns null for non-JSON', () => {
    expect(parseStatusPayload('not json')).toBeNull();
    expect(parseStatusPayload('')).toBeNull();
  });
});

describe('resolveCliInvocation', () => {
  const saved = process.env.GITNEXUS_HOOK_CLI_PATH;

  afterEach(() => {
    if (saved === undefined) delete process.env.GITNEXUS_HOOK_CLI_PATH;
    else process.env.GITNEXUS_HOOK_CLI_PATH = saved;
  });

  it('prefers GITNEXUS_HOOK_CLI_PATH when the file exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-opencode-'));
    const cli = path.join(dir, 'index.js');
    await fs.writeFile(cli, '// fake', 'utf-8');
    process.env.GITNEXUS_HOOK_CLI_PATH = cli;
    const invocation = resolveCliInvocation();
    expect(invocation?.argv).toContain(cli);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('prefers the built dist CLI, else falls back to a PATH binary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-opencode-'));
    process.env.GITNEXUS_HOOK_CLI_PATH = path.join(dir, 'missing.js');
    const invocation = resolveCliInvocation();
    // Resolution depends on whether the package was built: with dist/ present
    // (built checkout, published package) the node+dist form wins; on a fresh
    // source checkout it falls back to `gitnexus` on PATH.
    const distCli = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');
    let distExists = false;
    try {
      await fs.access(distCli);
      distExists = true;
    } catch {
      distExists = false;
    }
    if (distExists) {
      expect(invocation?.cmd).toBe(process.execPath);
      expect(invocation?.argv[0]).toBe(distCli);
    } else {
      expect(invocation?.cmd).toBe('gitnexus');
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('createAfterHook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITNEXUS_HOOK_CLI_PATH;
    spawnSyncMock.mockImplementation((cmd: string, argv: string[]) => {
      if (argv.includes('augment')) {
        return { error: undefined, status: 0, stderr: '[GitNexus] callers: A', stdout: '' };
      }
      if (argv.includes('status')) {
        return {
          error: undefined,
          status: 0,
          stdout: JSON.stringify({ schemaVersion: 1, status: 'up-to-date' }),
          stderr: '',
        };
      }
      return { error: undefined, status: 0, stdout: '', stderr: '' };
    });
  });

  it('appends augment context after a grep call', async () => {
    const after = createAfterHook('/repo');
    const output: Record<string, unknown> = { output: 'hits' };
    await after({ tool: 'grep', args: { pattern: 'UserService' } }, output);
    expect(spawnSyncMock).toHaveBeenCalled();
    expect(output.output).toBe('hits\n\n[GitNexus] callers: A');
  });

  it('stays silent when the pattern is too short', async () => {
    const after = createAfterHook('/repo');
    const output: Record<string, unknown> = { output: 'hits' };
    await after({ tool: 'grep', args: { pattern: 'ab' } }, output);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(output.output).toBe('hits');
  });

  it('ignores non-search tools', async () => {
    const after = createAfterHook('/repo');
    const output: Record<string, unknown> = { output: 'file' };
    await after({ tool: 'read', args: { filePath: 'a.ts' } }, output);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(output.output).toBe('file');
  });

  it('emits a stale hint after git mutations with a stale index', async () => {
    spawnSyncMock.mockImplementation((cmd: string, argv: string[]) => {
      if (argv.includes('status')) {
        return {
          error: undefined,
          status: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            status: 'stale',
            index: { commit: 'abc1234567' },
          }),
          stderr: '',
        };
      }
      return { error: undefined, status: 0, stdout: '', stderr: '' };
    });
    const after = createAfterHook('/repo');
    const output: Record<string, unknown> = { output: 'committed' };
    await after({ tool: 'bash', args: { command: 'git commit -m x' } }, output);
    expect(output.output).toContain('[GitNexus] GitNexus index is stale');
    expect(output.output).toContain('gitnexus analyze');
  });

  it('stays silent after git mutations with a fresh index', async () => {
    const after = createAfterHook('/repo');
    const output: Record<string, unknown> = { output: 'committed' };
    await after({ tool: 'bash', args: { command: 'git commit -m x' } }, output);
    expect(output.output).toBe('committed');
  });

  it('never throws and never coerces non-string results', async () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const after = createAfterHook('/repo');
    const output: Record<string, unknown> = { output: { structured: true } };
    await expect(
      after({ tool: 'grep', args: { pattern: 'UserService' } }, output),
    ).resolves.toBeUndefined();
    expect(output.output).toEqual({ structured: true });
    await expect(after(null, null)).resolves.toBeUndefined();
  });
});

describe('isShellMetaUnsafe / shouldSkipAugmentForShell', () => {
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
  ])('flags %s', (p) => expect(isShellMetaUnsafe(p)).toBe(true));

  it.each(['UserService', 'std::vector', 'foo-bar_baz', 'a.b/c'])('allows %s', (p) =>
    expect(isShellMetaUnsafe(p)).toBe(false),
  );

  it('rejects non-strings', () => {
    expect(isShellMetaUnsafe(null)).toBe(false);
    expect(isShellMetaUnsafe(undefined)).toBe(false);
  });

  it('skips only when the invocation needs a shell', () => {
    const shell = { cmd: 'gitnexus', argv: [], useShell: true };
    const node = { cmd: 'node', argv: ['cli.js'], useShell: false };
    expect(shouldSkipAugmentForShell(shell, 'foo & calc')).toBe(true);
    expect(shouldSkipAugmentForShell(shell, 'UserService')).toBe(false);
    expect(shouldSkipAugmentForShell(node, 'foo & calc')).toBe(false);
    expect(shouldSkipAugmentForShell(null, 'foo & calc')).toBe(false);
  });
});

describe('runAugment / checkIndexStale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITNEXUS_HOOK_CLI_PATH;
  });

  it('runAugment returns empty on CLI failure', () => {
    spawnSyncMock.mockReturnValue({ error: new Error('x'), status: 1, stderr: '', stdout: '' });
    expect(runAugment('UserService', '/repo')).toBe('');
  });

  it('checkIndexStale returns null unless positively stale', () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: JSON.stringify({ schemaVersion: 1, error: 'not-indexed' }),
      stderr: '',
    });
    expect(checkIndexStale('/repo')).toBeNull();
  });
});

describe('GitNexusPlugin', () => {
  it('registers tool.execute.after', async () => {
    const plugin = await GitNexusPlugin({ directory: '/repo' });
    expect(typeof plugin['tool.execute.after']).toBe('function');
  });
});
