import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { setupCommand } from '../../src/cli/setup.js';

describe('setupCommand skills integration', () => {
  let tempHome: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalPath = process.env.PATH;
  const testId = `${Date.now()}-${process.pid}`;
  const flatSkillName = `test-flat-skill-${testId}`;
  const dirSkillName = `test-dir-skill-${testId}`;
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const packageSkillsRoot = path.resolve(testDir, '..', '..', 'skills');

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-setup-home-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome; // os.homedir() checks USERPROFILE on Windows
    await fs.mkdir(path.join(tempHome, '.cursor'), { recursive: true });

    // Create temporary source skills to verify both supported source layouts:
    // - flat file: skills/{name}.md
    // - directory: skills/{name}/SKILL.md (+ nested files copied recursively)
    await fs.writeFile(
      path.join(packageSkillsRoot, `${flatSkillName}.md`),
      `---\nname: ${flatSkillName}\ndescription: temp flat skill\n---\n\n# Flat Test Skill`,
      'utf-8',
    );
    await fs.mkdir(path.join(packageSkillsRoot, dirSkillName, 'references'), { recursive: true });
    await fs.writeFile(
      path.join(packageSkillsRoot, dirSkillName, 'SKILL.md'),
      `---\nname: ${dirSkillName}\ndescription: temp directory skill\n---\n\n# Directory Test Skill`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(packageSkillsRoot, dirSkillName, 'references', 'note.md'),
      '# Directory Nested File',
      'utf-8',
    );
  });

  afterAll(async () => {
    await fs.rm(path.join(packageSkillsRoot, `${flatSkillName}.md`), { force: true });
    await fs.rm(path.join(packageSkillsRoot, dirSkillName), { recursive: true, force: true });
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    process.env.PATH = originalPath;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('reports the OpenCode skills install path with the plural skills directory', async () => {
    await fs.mkdir(path.join(tempHome, '.config', 'opencode'), { recursive: true });
    await setupCommand();

    const installedSkill = await fs.readFile(
      path.join(tempHome, '.config', 'opencode', 'skills', 'gitnexus-cli', 'SKILL.md'),
      'utf-8',
    );

    expect(installedSkill).toContain('GitNexus CLI Commands');
    await expect(
      fs.access(path.join(tempHome, '.config', 'opencode', 'skill', 'gitnexus-cli', 'SKILL.md')),
    ).rejects.toThrow();
  });

  it('installs packaged, flat-file, and directory skills into cursor skills directory', async () => {
    const legacyReviewDir = path.join(tempHome, '.cursor', 'skills', 'gitnexus-pr-review');
    await fs.mkdir(legacyReviewDir, { recursive: true });
    await fs.writeFile(path.join(legacyReviewDir, 'SKILL.md'), 'legacy review skill', 'utf-8');

    await setupCommand();

    const cursorSkillsRoot = path.join(tempHome, '.cursor', 'skills');
    const entries = await fs.readdir(cursorSkillsRoot, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    expect(skillDirs.length).toBeGreaterThan(0);
    expect(skillDirs).toContain('gitnexus-cli');

    const skillContent = await fs.readFile(
      path.join(cursorSkillsRoot, 'gitnexus-cli', 'SKILL.md'),
      'utf-8',
    );
    expect(skillContent).toContain('GitNexus CLI Commands');

    const reviewContent = await fs.readFile(
      path.join(cursorSkillsRoot, 'gitnexus-review', 'SKILL.md'),
      'utf-8',
    );
    expect(reviewContent).toContain('name: gitnexus-review');
    // The legacy directory survives the rename untouched: the installer cannot
    // prove it owns the contents, so it warns instead of deleting (#2431 review).
    const legacyContent = await fs.readFile(path.join(legacyReviewDir, 'SKILL.md'), 'utf-8');
    expect(legacyContent).toBe('legacy review skill');

    // Flat file source should be installed as {name}/SKILL.md.
    const flatInstalled = await fs.readFile(
      path.join(cursorSkillsRoot, flatSkillName, 'SKILL.md'),
      'utf-8',
    );
    expect(flatInstalled).toContain('# Flat Test Skill');

    // Directory source should be copied recursively with nested files preserved.
    const dirInstalled = await fs.readFile(
      path.join(cursorSkillsRoot, dirSkillName, 'SKILL.md'),
      'utf-8',
    );
    expect(dirInstalled).toContain('# Directory Test Skill');
    const nestedInstalled = await fs.readFile(
      path.join(cursorSkillsRoot, dirSkillName, 'references', 'note.md'),
      'utf-8',
    );
    expect(nestedInstalled).toContain('Directory Nested File');
  });

  it('falls back to Codex config.toml and installs skills into ~/.agents/skills when codex CLI is unavailable', async () => {
    await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true });
    process.env.PATH = '';

    await setupCommand();

    const codexConfig = await fs.readFile(path.join(tempHome, '.codex', 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('[mcp_servers.gitnexus]');
    expect(codexConfig).toMatch(/gitnexus@\d+\.\d+\.\d+/);

    const codexSkill = await fs.readFile(
      path.join(tempHome, '.agents', 'skills', 'gitnexus-cli', 'SKILL.md'),
      'utf-8',
    );
    expect(codexSkill).toContain('GitNexus CLI Commands');
  });

  it('does not duplicate the Codex MCP section on repeated fallback setup runs', async () => {
    await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true });
    process.env.PATH = '';

    await setupCommand();
    await setupCommand();

    const codexConfig = await fs.readFile(path.join(tempHome, '.codex', 'config.toml'), 'utf-8');
    const sectionMatches = codexConfig.match(/\[mcp_servers\.gitnexus\]/g) ?? [];

    expect(sectionMatches).toHaveLength(1);
  });

  it('warns when a legacy renamed skill dir exists in a target, leaving it in place', async () => {
    const legacyReviewDir = path.join(tempHome, '.cursor', 'skills', 'gitnexus-pr-review');
    await fs.mkdir(legacyReviewDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyReviewDir, 'SKILL.md'),
      'customized legacy content',
      'utf-8',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await setupCommand();
    const logged = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(logged).toContain('skill "gitnexus-pr-review" was renamed to "gitnexus-review"');
    // The warning pairs with non-destruction: the legacy dir survives untouched.
    const legacyContent = await fs.readFile(path.join(legacyReviewDir, 'SKILL.md'), 'utf-8');
    expect(legacyContent).toBe('customized legacy content');
  });

  it('does not warn about the rename when no legacy dir exists in any target', async () => {
    // Earlier tests leave gitnexus-pr-review behind on purpose — clear it from
    // every skill destination this suite can install into before asserting.
    const targetRoots = [
      path.join(tempHome, '.cursor', 'skills'),
      path.join(tempHome, '.config', 'opencode', 'skills'),
      path.join(tempHome, '.agents', 'skills'),
      path.join(tempHome, '.claude', 'skills'),
    ];
    await Promise.all(
      targetRoots.map((root) =>
        fs.rm(path.join(root, 'gitnexus-pr-review'), { recursive: true, force: true }),
      ),
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await setupCommand();
    const logged = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(logged).not.toContain('was renamed to');
  });
});
