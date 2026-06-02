import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// Match what setup.ts emits — read the version from the same package.json
// so the test never goes stale on a release bump.
const PKG_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version;
const MCP_PINNED_REF = `gitnexus@${PKG_VERSION}`;

const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    callback(null, '', '');
  }
});

// By default, execFileSync throws (simulating `which gitnexus` not found)
// so getMcpEntry() falls back to the npx path.
const execFileSyncMock = vi.fn(() => {
  throw new Error('not found');
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

describe('setupClaudeCode', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let platformDescriptor: PropertyDescriptor | undefined;

  const setPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', {
      value,
      configurable: true,
    });
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-claude-setup-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    // Only create ~/.claude — no other editor directories so their
    // setup functions skip and don't pollute assertions.
    await fs.mkdir(path.join(tempHome, '.claude'), { recursive: true });

    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }

    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('writes win32 MCP entry with cmd wrapper', async () => {
    setPlatform('win32');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', MCP_PINNED_REF, 'mcp'],
    });
  });

  it('writes non-win32 MCP entry with npx directly', async () => {
    setPlatform('darwin');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'npx',
      args: ['-y', MCP_PINNED_REF, 'mcp'],
    });
  });

  it('skips when ~/.claude directory does not exist', async () => {
    await fs.rm(path.join(tempHome, '.claude'), { recursive: true, force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(fs.access(path.join(tempHome, '.claude.json'))).rejects.toThrow();
  });

  it('preserves existing keys in ~/.claude.json', async () => {
    setPlatform('linux');

    await fs.writeFile(
      path.join(tempHome, '.claude.json'),
      JSON.stringify({ existingKey: 'keep-me', mcpServers: { other: { command: 'foo' } } }),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.existingKey).toBe('keep-me');
    expect(config.mcpServers.other).toEqual({ command: 'foo' });
    expect(config.mcpServers.gitnexus).toBeDefined();
  });

  it('handles missing ~/.claude.json (creates fresh)', async () => {
    setPlatform('linux');

    // Ensure no pre-existing file
    await fs.rm(path.join(tempHome, '.claude.json'), { force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toBeDefined();
  });

  it('handles corrupt JSON gracefully', async () => {
    setPlatform('linux');

    const corrupt = '{ this is not valid json !!!';
    await fs.writeFile(path.join(tempHome, '.claude.json'), corrupt, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    // mergeJsoncFile leaves corrupt files untouched (safer than overwriting)
    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    expect(raw).toBe(corrupt);
  });

  it('uses global binary path when gitnexus is on PATH', async () => {
    setPlatform('darwin');
    execFileSyncMock.mockReturnValueOnce('/usr/local/bin/gitnexus\n');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: '/usr/local/bin/gitnexus',
      args: ['mcp'],
    });
  });

  it('falls back to npx when gitnexus is not on PATH', async () => {
    setPlatform('darwin');
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('not found');
    });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'npx',
      args: ['-y', MCP_PINNED_REF, 'mcp'],
    });
  });

  it('picks .cmd wrapper from Windows where output (multiple lines)', async () => {
    setPlatform('win32');
    // `where gitnexus` on Windows returns the POSIX script first, then .cmd
    execFileSyncMock.mockReturnValueOnce(
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus\nC:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.cmd\n',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.cmd',
      args: ['mcp'],
    });
  });

  it('handles CRLF line endings from Windows where output', async () => {
    setPlatform('win32');
    // Windows `where` produces CRLF line endings
    execFileSyncMock.mockReturnValueOnce(
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus\r\nC:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.cmd\r\n',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.cmd',
      args: ['mcp'],
    });
  });

  it('picks .bat wrapper when .cmd is not present', async () => {
    setPlatform('win32');
    execFileSyncMock.mockReturnValueOnce(
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus\nC:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.bat\n',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.bat',
      args: ['mcp'],
    });
  });

  it('handles uppercase .CMD extension (case-insensitive match)', async () => {
    setPlatform('win32');
    execFileSyncMock.mockReturnValueOnce(
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus\nC:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.CMD\n',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.CMD',
      args: ['mcp'],
    });
  });

  it('copies shared hook helpers (incl. resolve-analyze-cmd.cjs) to ~/.claude/hooks/gitnexus/', async () => {
    setPlatform('linux');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const destHooksDir = path.join(tempHome, '.claude', 'hooks', 'gitnexus');
    await expect(fs.access(path.join(destHooksDir, 'hook-lock.cjs'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(destHooksDir, 'hook-db-lock-probe.cjs')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(destHooksDir, 'win-rm-list-json.ps1')),
    ).resolves.toBeUndefined();
    // The Claude adapter top-level require()s this; without it the installed
    // hook would crash with MODULE_NOT_FOUND (the antigravity-side bug class).
    await expect(
      fs.access(path.join(destHooksDir, 'resolve-analyze-cmd.cjs')),
    ).resolves.toBeUndefined();
  });

  it('records errors and returns the failed REQUIRED helpers when copies fail', async () => {
    const { copyHookHelpers } = await import('../../src/cli/setup.js');
    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-copy-helpers-'));
    const result = { configured: [] as string[], skipped: [] as string[], errors: [] as string[] };
    try {
      // A non-existent source dir makes every helper copy fail.
      const failedRequired = await copyHookHelpers(
        path.join(destDir, 'nope'),
        destDir,
        'Claude Code hooks',
        result,
      );
      expect(result.errors.length).toBe(4);
      expect(result.errors.some((e) => e.includes('resolve-analyze-cmd.cjs'))).toBe(true);
      expect(result.errors.every((e) => e.startsWith('Claude Code hooks:'))).toBe(true);
      // Only the hard-required .cjs trio gates registration; win-rm is best-effort.
      expect([...failedRequired].sort()).toEqual([
        'hook-db-lock-probe.cjs',
        'hook-lock.cjs',
        'resolve-analyze-cmd.cjs',
      ]);
      expect(failedRequired).not.toContain('win-rm-list-json.ps1');
    } finally {
      await fs.rm(destDir, { recursive: true, force: true });
    }
  });

  it('treats win-rm-list-json.ps1 as best-effort (no required failure when only it is missing)', async () => {
    const { copyHookHelpers } = await import('../../src/cli/setup.js');
    const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-helpers-src-'));
    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-helpers-dest-'));
    const result = { configured: [] as string[], skipped: [] as string[], errors: [] as string[] };
    try {
      // Provide the three hard-required .cjs helpers; omit win-rm-list-json.ps1.
      for (const h of ['hook-lock.cjs', 'hook-db-lock-probe.cjs', 'resolve-analyze-cmd.cjs']) {
        await fs.writeFile(path.join(srcDir, h), '// stub\n', 'utf-8');
      }
      const failedRequired = await copyHookHelpers(srcDir, destDir, 'Claude Code hooks', result);
      expect(failedRequired).toEqual([]);
      // The best-effort helper still records a (non-gating) error.
      expect(result.errors.some((e) => e.includes('win-rm-list-json.ps1'))).toBe(true);
    } finally {
      await fs.rm(srcDir, { recursive: true, force: true });
      await fs.rm(destDir, { recursive: true, force: true });
    }
  });

  it('does not register the Claude hook when a required helper fails to copy (fail closed)', async () => {
    setPlatform('linux');
    const realCopyFile = fs.copyFile.bind(fs);
    vi.spyOn(fs, 'copyFile').mockImplementation(((src: any, dest: any, ...rest: any[]) => {
      if (String(src).endsWith('resolve-analyze-cmd.cjs')) {
        return Promise.reject(new Error('simulated copy failure'));
      }
      return realCopyFile(src, dest, ...rest);
    }) as typeof fs.copyFile);

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    // Registration must have been skipped — settings.json must not reference the hook.
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    let registered = false;
    try {
      registered = (await fs.readFile(settingsPath, 'utf-8')).includes('gitnexus-hook.cjs');
    } catch {
      registered = false;
    }
    expect(registered).toBe(false);
  });

  it('falls back to npx on Windows when no .cmd/.bat wrapper is found', async () => {
    setPlatform('win32');
    // Edge case: where returns only a non-spawnable shim (no .cmd wrapper)
    execFileSyncMock.mockReturnValueOnce('C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus\n');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', MCP_PINNED_REF, 'mcp'],
    });
  });

  it('falls back to npx on Windows when where returns only a .ps1 path', async () => {
    setPlatform('win32');
    execFileSyncMock.mockReturnValueOnce('C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.ps1\n');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', MCP_PINNED_REF, 'mcp'],
    });
  });

  // The hook `command` string is shell-evaluated by the editor. On POSIX the
  // installed path lives under $HOME, which can legitimately contain spaces and
  // (adversarially) shell metacharacters; the command must neutralize them.
  it('single-quotes the POSIX hook command so the path cannot word-split or expand', async () => {
    setPlatform('linux');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const settings = JSON.parse(
      await fs.readFile(path.join(tempHome, '.claude', 'settings.json'), 'utf-8'),
    );
    const cmd: string = settings.hooks.PreToolUse[0].hooks[0].command;
    // setup.ts forward-slash-normalizes the hook path (`.replace(/\\/g, '/')`)
    // before quoting, so normalize the expected path the same way — otherwise
    // path.join emits backslashes on the Windows runner and this mismatches.
    const hookPath = path
      .join(tempHome, '.claude', 'hooks', 'gitnexus', 'gitnexus-hook.cjs')
      .replace(/\\/g, '/');
    // Single-quoted, not double-quoted, and the path is the literal inside quotes.
    expect(cmd).toBe(`node '${hookPath}'`);
    expect(cmd.startsWith("node '")).toBe(true);
    expect(cmd).not.toMatch(/^node "/);
  });
});

describe('formatHookCommand (hook command escaping, #1945)', () => {
  let mod: typeof import('../../src/cli/setup.js');

  beforeEach(async () => {
    mod = await import('../../src/cli/setup.js');
  });

  it('single-quotes an ordinary POSIX path', () => {
    expect(mod.formatHookCommand('/home/dev/.claude/hooks/gitnexus/gitnexus-hook.cjs', false)).toBe(
      "node '/home/dev/.claude/hooks/gitnexus/gitnexus-hook.cjs'",
    );
  });

  it('neutralizes spaces in a POSIX path (no word-splitting)', () => {
    expect(mod.formatHookCommand('/home/a b/.claude/gitnexus-hook.cjs', false)).toBe(
      "node '/home/a b/.claude/gitnexus-hook.cjs'",
    );
  });

  it('neutralizes shell metacharacters in a POSIX path ($, backtick, ;)', () => {
    // Single-quoting means none of these can expand or run as a command.
    const evil = '/home/u$(id)/`whoami`/a;b/.claude/gitnexus-hook.cjs';
    expect(mod.formatHookCommand(evil, false)).toBe(`node '${evil}'`);
  });

  it("escapes a single quote in a POSIX path via the '\\'' idiom", () => {
    expect(mod.formatHookCommand("/home/o'brien/.claude/gitnexus-hook.cjs", false)).toBe(
      "node '/home/o'\\''brien/.claude/gitnexus-hook.cjs'",
    );
  });

  it('keeps the double-quoted form on Windows (metacharacters are illegal in filenames)', () => {
    expect(mod.formatHookCommand('C:/Users/dev/.claude/gitnexus-hook.cjs', true)).toBe(
      'node "C:/Users/dev/.claude/gitnexus-hook.cjs"',
    );
  });
});
