import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { setupCommand } from '../../src/cli/setup.js';

describe('setupCommand skills integration', () => {
  let tempHome: string;
  const originalHome = process.env.HOME;
  const testId = `${Date.now()}-${process.pid}`;
  const flatSkillName = `test-flat-skill-${testId}`;
  const dirSkillName = `test-dir-skill-${testId}`;
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const packageSkillsRoot = path.resolve(testDir, '..', '..', 'skills');

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-setup-home-'));
    process.env.HOME = tempHome;
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
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('installs packaged, flat-file, and directory skills into cursor skills directory', async () => {
    await setupCommand();

    const cursorSkillsRoot = path.join(tempHome, '.cursor', 'skills');
    const entries = await fs.readdir(cursorSkillsRoot, { withFileTypes: true });
    const skillDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

    expect(skillDirs.length).toBeGreaterThan(0);
    expect(skillDirs).toContain('gitnexus-cli');

    const skillContent = await fs.readFile(
      path.join(cursorSkillsRoot, 'gitnexus-cli', 'SKILL.md'),
      'utf-8',
    );
    expect(skillContent).toContain('GitNexus CLI Commands');

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
});
