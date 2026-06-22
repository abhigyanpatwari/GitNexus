import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Codex uninstall shells out to `codex mcp remove`; make it fail by default
// so the TOML-strip fallback path is exercised in tests that don't override it.
const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    callback(new Error('codex not found'), '', '');
  }
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

describe('uninstallCommand', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalSkillsRoot: string | undefined;
  let originalExitCode: typeof process.exitCode;
  let skillsRoot: string;

  const importUninstall = async () => (await import('../../src/cli/uninstall.js')).uninstallCommand;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalSkillsRoot = process.env.GITNEXUS_TEST_SKILLS_ROOT;
    originalExitCode = process.exitCode;

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-uninstall-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    // Stage a fixture skills source so listGitnexusSkillNames() resolves
    // deterministically without depending on __dirname under Vitest.
    skillsRoot = path.join(tempHome, 'pkg-skills');
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.writeFile(path.join(skillsRoot, 'gitnexus-exploring.md'), '# explore', 'utf-8');
    await fs.writeFile(path.join(skillsRoot, 'gitnexus-cli.md'), '# cli', 'utf-8');
    process.env.GITNEXUS_TEST_SKILLS_ROOT = skillsRoot;

    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    if (originalSkillsRoot === undefined) delete process.env.GITNEXUS_TEST_SKILLS_ROOT;
    else process.env.GITNEXUS_TEST_SKILLS_ROOT = originalSkillsRoot;
    // The command sets process.exitCode=1 on partial failure; restore it so a
    // test exercising that path doesn't make the whole vitest run exit non-zero.
    process.exitCode = originalExitCode;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('removes the gitnexus MCP entry from ~/.claude.json, preserving others', async () => {
    const claudeJson = path.join(tempHome, '.claude.json');
    await fs.writeFile(
      claudeJson,
      JSON.stringify({
        existingKey: 'keep-me',
        mcpServers: {
          gitnexus: { command: 'gitnexus', args: ['mcp'] },
          other: { command: 'foo' },
        },
      }),
      'utf-8',
    );

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    const config = JSON.parse(await fs.readFile(claudeJson, 'utf-8'));
    expect(config.mcpServers.gitnexus).toBeUndefined();
    expect(config.mcpServers.other).toEqual({ command: 'foo' });
    expect(config.existingKey).toBe('keep-me');
  });

  it('dry run (no --force) leaves files untouched', async () => {
    const claudeJson = path.join(tempHome, '.claude.json');
    const raw = JSON.stringify({
      mcpServers: { gitnexus: { command: 'gitnexus', args: ['mcp'] } },
    });
    await fs.writeFile(claudeJson, raw, 'utf-8');

    const uninstallCommand = await importUninstall();
    await uninstallCommand();

    expect(await fs.readFile(claudeJson, 'utf-8')).toBe(raw);
  });

  it('removes gitnexus hook entries and the hook-script dir, preserving other hooks', async () => {
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    await fs.mkdir(path.join(tempHome, '.claude'), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'node ".../gitnexus-hook.cjs"' }],
            },
            { matcher: 'Read', hooks: [{ type: 'command', command: 'my-own-hook' }] },
          ],
          PostToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'node ".../gitnexus-hook.cjs"' }],
            },
          ],
        },
      }),
      'utf-8',
    );
    const hookDir = path.join(tempHome, '.claude', 'hooks', 'gitnexus');
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(path.join(hookDir, 'gitnexus-hook.cjs'), '// hook', 'utf-8');

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    const config = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe('my-own-hook');
    expect(config.hooks.PostToolUse).toHaveLength(0);
    await expect(fs.access(hookDir)).rejects.toThrow();
  });

  it('removes installed gitnexus skill directories from ~/.claude/skills', async () => {
    const skillsDir = path.join(tempHome, '.claude', 'skills');
    await fs.mkdir(path.join(skillsDir, 'gitnexus-exploring'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'gitnexus-exploring', 'SKILL.md'), '# x', 'utf-8');
    await fs.mkdir(path.join(skillsDir, 'gitnexus-cli'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'gitnexus-cli', 'SKILL.md'), '# y', 'utf-8');
    // A user's own skill that must survive.
    await fs.mkdir(path.join(skillsDir, 'my-skill'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'my-skill', 'SKILL.md'), '# mine', 'utf-8');

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    await expect(fs.access(path.join(skillsDir, 'gitnexus-exploring'))).rejects.toThrow();
    await expect(fs.access(path.join(skillsDir, 'gitnexus-cli'))).rejects.toThrow();
    await expect(fs.access(path.join(skillsDir, 'my-skill'))).resolves.toBeUndefined();
  });

  it('strips the [mcp_servers.gitnexus] section from Codex config.toml, keeping other tables', async () => {
    const codexDir = path.join(tempHome, '.codex');
    await fs.mkdir(codexDir, { recursive: true });
    const configPath = path.join(codexDir, 'config.toml');
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.other]',
        'command = "other"',
        'args = ["mcp"]',
        '',
        '[mcp_servers.gitnexus]',
        'command = "gitnexus"',
        'args = ["mcp"]',
        '',
      ].join('\n'),
      'utf-8',
    );

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    const result = await fs.readFile(configPath, 'utf-8');
    expect(result).not.toContain('[mcp_servers.gitnexus]');
    expect(result).toContain('[mcp_servers.other]');
    expect(result).toContain('command = "other"');
  });

  it('leaves a corrupt JSON config untouched', async () => {
    const claudeJson = path.join(tempHome, '.claude.json');
    const corrupt = '{ not valid json !!!';
    await fs.writeFile(claudeJson, corrupt, 'utf-8');

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    expect(await fs.readFile(claudeJson, 'utf-8')).toBe(corrupt);
  });

  it('is a no-op when nothing is configured', async () => {
    const uninstallCommand = await importUninstall();
    await expect(uninstallCommand({ force: true })).resolves.toBeUndefined();
  });

  // ── #1: empty derived skill name must not wipe the whole skills dir ──
  it('does not wipe the skills dir when the source has a bare ".md" file', async () => {
    // A stray bare ".md" → basename('.md', '.md') === '' → would resolve to
    // the skills dir itself if unguarded.
    await fs.writeFile(path.join(skillsRoot, '.md'), 'stray', 'utf-8');

    const skillsDir = path.join(tempHome, '.claude', 'skills');
    await fs.mkdir(path.join(skillsDir, 'gitnexus-exploring'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'gitnexus-exploring', 'SKILL.md'), '# x', 'utf-8');
    await fs.mkdir(path.join(skillsDir, 'user-skill'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'user-skill', 'SKILL.md'), '# mine', 'utf-8');

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    // The skills dir and the user skill survive; only the gitnexus skill went.
    await expect(fs.access(skillsDir)).resolves.toBeUndefined();
    await expect(fs.access(path.join(skillsDir, 'user-skill'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(skillsDir, 'gitnexus-exploring'))).rejects.toThrow();
  });

  // ── #2: corrupt settings.json must not orphan the hook script ──
  it('keeps the hook-script dir when settings.json is corrupt (avoids dangling hook)', async () => {
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    await fs.mkdir(path.join(tempHome, '.claude'), { recursive: true });
    const corrupt = '{ not valid json !!!';
    await fs.writeFile(settingsPath, corrupt, 'utf-8');
    const hookDir = path.join(tempHome, '.claude', 'hooks', 'gitnexus');
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(path.join(hookDir, 'gitnexus-hook.cjs'), '// hook', 'utf-8');

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    // Entry couldn't be removed → script dir must stay, and we flag failure.
    expect(await fs.readFile(settingsPath, 'utf-8')).toBe(corrupt);
    await expect(fs.access(hookDir)).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  // ── #3: element-granular hook removal preserves a co-located user hook ──
  it('removes only the gitnexus command from a shared hook entry, keeping user commands', async () => {
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    await fs.mkdir(path.join(tempHome, '.claude'), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: 'node ".../gitnexus-hook.cjs"' },
                { type: 'command', command: 'my-own-inline-hook' },
              ],
            },
          ],
        },
      }),
      'utf-8',
    );

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    const config = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
    // Entry survives because it still holds the user's command.
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe('my-own-inline-hook');
  });

  // ── OpenCode MCP uses a distinct keyPath: ['mcp', 'gitnexus'] ──
  it('removes the gitnexus entry from OpenCode opencode.json (mcp.gitnexus), preserving others', async () => {
    const opencodeJson = path.join(tempHome, '.config', 'opencode', 'opencode.json');
    await fs.mkdir(path.dirname(opencodeJson), { recursive: true });
    await fs.writeFile(
      opencodeJson,
      JSON.stringify({
        mcp: {
          gitnexus: { type: 'local', command: ['gitnexus', 'mcp'] },
          other: { type: 'local', command: ['foo'] },
        },
      }),
      'utf-8',
    );

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    const config = JSON.parse(await fs.readFile(opencodeJson, 'utf-8'));
    expect(config.mcp.gitnexus).toBeUndefined();
    expect(config.mcp.other).toEqual({ type: 'local', command: ['foo'] });
  });

  // ── Antigravity MCP + hooks (AfterTool / gitnexus-antigravity-hook) ──
  it('removes Antigravity MCP and AfterTool hooks plus the adapter script dir', async () => {
    const mcpPath = path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json');
    await fs.mkdir(path.dirname(mcpPath), { recursive: true });
    await fs.writeFile(
      mcpPath,
      JSON.stringify({ mcpServers: { gitnexus: { command: 'gitnexus', args: ['mcp'] } } }),
      'utf-8',
    );

    const geminiSettings = path.join(tempHome, '.gemini', 'settings.json');
    await fs.writeFile(
      geminiSettings,
      JSON.stringify({
        hooks: {
          AfterTool: [
            {
              matcher: 'search_file_content|glob|run_shell_command',
              hooks: [{ type: 'command', command: 'node ".../gitnexus-antigravity-hook.cjs"' }],
            },
            { matcher: 'glob', hooks: [{ type: 'command', command: 'user-after-tool' }] },
          ],
        },
      }),
      'utf-8',
    );
    const adapterDir = path.join(tempHome, '.gemini', 'config', 'hooks', 'gitnexus');
    await fs.mkdir(adapterDir, { recursive: true });
    await fs.writeFile(path.join(adapterDir, 'gitnexus-antigravity-hook.cjs'), '// a', 'utf-8');

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    expect(JSON.parse(await fs.readFile(mcpPath, 'utf-8')).mcpServers.gitnexus).toBeUndefined();
    const settings = JSON.parse(await fs.readFile(geminiSettings, 'utf-8'));
    expect(settings.hooks.AfterTool).toHaveLength(1);
    expect(settings.hooks.AfterTool[0].hooks[0].command).toBe('user-after-tool');
    await expect(fs.access(adapterDir)).rejects.toThrow();
  });

  // ── Codex success path: prefer `codex mcp remove`, don't touch the file ──
  it('uses `codex mcp remove` when the binary succeeds and leaves config.toml untouched', async () => {
    execFileMock.mockImplementationOnce((...args: any[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') callback(null, '', '');
    });
    const configPath = path.join(tempHome, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const raw = ['[mcp_servers.gitnexus]', 'command = "gitnexus"', 'args = ["mcp"]', ''].join('\n');
    await fs.writeFile(configPath, raw, 'utf-8');

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    expect(execFileMock).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'remove', 'gitnexus'],
      expect.any(Object),
      expect.any(Function),
    );
    // CLI path handles removal; we must not also rewrite the file.
    expect(await fs.readFile(configPath, 'utf-8')).toBe(raw);
  });

  // ── #5: TOML fallback also strips descendant sub-tables ──
  it('strips a [mcp_servers.gitnexus.env] sub-table along with the parent', async () => {
    const configPath = path.join(tempHome, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.other]',
        'command = "other"',
        '',
        '[mcp_servers.gitnexus]',
        'command = "gitnexus"',
        '',
        '[mcp_servers.gitnexus.env]',
        'FOO = "bar"',
        '',
        '[mcp_servers.zeta]',
        'command = "zeta"',
        '',
      ].join('\n'),
      'utf-8',
    );

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    const out = await fs.readFile(configPath, 'utf-8');
    expect(out).not.toContain('[mcp_servers.gitnexus]');
    expect(out).not.toContain('[mcp_servers.gitnexus.env]');
    expect(out).not.toContain('FOO = "bar"');
    expect(out).toContain('[mcp_servers.other]');
    expect(out).toContain('[mcp_servers.zeta]');
    expect(out).toContain('command = "zeta"');
  });

  // ── #5: TOML fallback ignores a [header] inside a multiline string ──
  it('does not truncate a multiline string that contains a [mcp_servers.gitnexus] literal', async () => {
    const configPath = path.join(tempHome, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.other]',
        'note = """',
        '[mcp_servers.gitnexus]',
        'not a real header',
        '"""',
        'command = "other"',
        '',
        '[mcp_servers.gitnexus]',
        'command = "gitnexus"',
        '',
      ].join('\n'),
      'utf-8',
    );

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    const out = await fs.readFile(configPath, 'utf-8');
    // The multiline literal is preserved...
    expect(out).toContain('not a real header');
    expect(out).toContain('command = "other"');
    // ...but the real section's body is gone.
    expect(out).not.toContain('command = "gitnexus"');
  });

  // ── #5 (regression): a multiline line containing an odd count of BOTH
  // delimiters must not desync the scanner (it previously stuck in multiline
  // mode and failed to strip the real section). ──
  it('strips the real section even when a multiline string mixes \'\'\' and """ on one line', async () => {
    const configPath = path.join(tempHome, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.other]',
        // Opens a ''' literal; the """ on this same line is data, not an opener.
        'note = \'\'\'has """ inside',
        'still in string [mcp_servers.gitnexus]',
        "'''",
        'command = "other"',
        '',
        '[mcp_servers.gitnexus]',
        'command = "gitnexus"',
        '',
      ].join('\n'),
      'utf-8',
    );

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    const out = await fs.readFile(configPath, 'utf-8');
    // The multiline literal (incl. the fake header line) is preserved...
    expect(out).toContain('still in string [mcp_servers.gitnexus]');
    expect(out).toContain('command = "other"');
    // ...and the real section was actually removed (the bug left it behind).
    expect(out).not.toContain('command = "gitnexus"');
  });

  // ── sweep: a section header with a trailing inline comment is still stripped ──
  it('strips a [mcp_servers.gitnexus] header that has a trailing inline comment', async () => {
    const configPath = path.join(tempHome, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.other]',
        'command = "other"',
        '',
        '[mcp_servers.gitnexus] # GitNexus MCP',
        'command = "gitnexus"',
        '',
      ].join('\n'),
      'utf-8',
    );

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    const out = await fs.readFile(configPath, 'utf-8');
    expect(out).not.toContain('mcp_servers.gitnexus');
    expect(out).not.toContain('command = "gitnexus"');
    expect(out).toContain('[mcp_servers.other]');
  });

  // ── sweep: CRLF config.toml keeps its line endings (no silent LF rewrite) ──
  it('preserves CRLF line endings when stripping the Codex section', async () => {
    const configPath = path.join(tempHome, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.other]',
        'command = "other"',
        '',
        '[mcp_servers.gitnexus]',
        'command = "gitnexus"',
        '',
      ].join('\r\n'),
      'utf-8',
    );

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    const out = await fs.readFile(configPath, 'utf-8');
    expect(out).not.toContain('[mcp_servers.gitnexus]');
    expect(out).toContain('[mcp_servers.other]');
    expect(out).toContain('\r\n');
    // No bare LF: every newline is part of a CRLF.
    expect(out).not.toMatch(/[^\r]\n/);
  });

  // ── dry-run leaves hooks and skills intact ──
  it('dry run does not remove hooks, hook scripts, or skills', async () => {
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    await fs.mkdir(path.join(tempHome, '.claude'), { recursive: true });
    const settingsRaw = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'node ".../gitnexus-hook.cjs"' }],
          },
        ],
      },
    });
    await fs.writeFile(settingsPath, settingsRaw, 'utf-8');
    const hookDir = path.join(tempHome, '.claude', 'hooks', 'gitnexus');
    await fs.mkdir(hookDir, { recursive: true });
    const skillsDir = path.join(tempHome, '.claude', 'skills', 'gitnexus-cli');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'SKILL.md'), '# y', 'utf-8');

    const uninstallCommand = await importUninstall();
    await uninstallCommand(); // no --force

    expect(await fs.readFile(settingsPath, 'utf-8')).toBe(settingsRaw);
    await expect(fs.access(hookDir)).resolves.toBeUndefined();
    await expect(fs.access(skillsDir)).resolves.toBeUndefined();
  });

  // ── skills: directory-layout source ({name}/SKILL.md) is recognized ──
  it('removes a directory-layout skill ({name}/SKILL.md) from a target', async () => {
    await fs.mkdir(path.join(skillsRoot, 'gitnexus-dir-skill'), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, 'gitnexus-dir-skill', 'SKILL.md'), '# d', 'utf-8');

    // Use a non-Claude target to also exercise a second skill destination.
    const opencodeSkills = path.join(tempHome, '.config', 'opencode', 'skills');
    await fs.mkdir(path.join(opencodeSkills, 'gitnexus-dir-skill'), { recursive: true });
    await fs.writeFile(path.join(opencodeSkills, 'gitnexus-dir-skill', 'SKILL.md'), '# d', 'utf-8');
    await fs.mkdir(path.join(opencodeSkills, 'keep-me'), { recursive: true });

    const uninstallCommand = await importUninstall();
    await uninstallCommand({ force: true });

    await expect(fs.access(path.join(opencodeSkills, 'gitnexus-dir-skill'))).rejects.toThrow();
    await expect(fs.access(path.join(opencodeSkills, 'keep-me'))).resolves.toBeUndefined();
  });
});
