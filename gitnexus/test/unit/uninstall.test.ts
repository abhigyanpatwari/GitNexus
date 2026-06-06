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
  let skillsRoot: string;

  const importUninstall = async () => (await import('../../src/cli/uninstall.js')).uninstallCommand;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalSkillsRoot = process.env.GITNEXUS_TEST_SKILLS_ROOT;

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
});
