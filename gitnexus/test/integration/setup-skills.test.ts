import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { installSkillsTo } from '../../src/cli/setup.js';

describe('setup skill installation', () => {
  let tempRoot: string;
  let skillsRoot: string;
  let targetDir: string;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-setup-skills-'));
    skillsRoot = path.join(tempRoot, 'skills');
    targetDir = path.join(tempRoot, 'target');
    await fs.mkdir(skillsRoot, { recursive: true });

    // Flat-file skill
    await fs.writeFile(
      path.join(skillsRoot, 'flat-only.md'),
      '---\nname: flat-only\ndescription: flat\n---\n\n# Flat only',
      'utf-8',
    );

    // Directory skill
    await fs.mkdir(path.join(skillsRoot, 'dir-only', 'references'), { recursive: true });
    await fs.writeFile(
      path.join(skillsRoot, 'dir-only', 'SKILL.md'),
      '---\nname: dir-only\ndescription: dir\n---\n\n# Dir only',
      'utf-8',
    );
    await fs.writeFile(
      path.join(skillsRoot, 'dir-only', 'references', 'note.md'),
      '# Nested note',
      'utf-8',
    );

    // Both layouts for same skill name — directory should win
    await fs.writeFile(
      path.join(skillsRoot, 'prefer-dir.md'),
      '---\nname: prefer-dir\ndescription: flat\n---\n\n# Flat should lose',
      'utf-8',
    );
    await fs.mkdir(path.join(skillsRoot, 'prefer-dir'), { recursive: true });
    await fs.writeFile(
      path.join(skillsRoot, 'prefer-dir', 'SKILL.md'),
      '---\nname: prefer-dir\ndescription: dir\n---\n\n# Directory should win',
      'utf-8',
    );
  });

  afterAll(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('installs skills from flat and directory layouts', async () => {
    const installed = await installSkillsTo(targetDir, skillsRoot);
    expect(installed).toEqual(expect.arrayContaining(['flat-only', 'dir-only', 'prefer-dir']));

    const flatInstalled = await fs.readFile(path.join(targetDir, 'flat-only', 'SKILL.md'), 'utf-8');
    expect(flatInstalled).toContain('# Flat only');

    const dirInstalled = await fs.readFile(path.join(targetDir, 'dir-only', 'SKILL.md'), 'utf-8');
    expect(dirInstalled).toContain('# Dir only');
    const nestedInstalled = await fs.readFile(
      path.join(targetDir, 'dir-only', 'references', 'note.md'),
      'utf-8',
    );
    expect(nestedInstalled).toContain('Nested note');

    const preferred = await fs.readFile(path.join(targetDir, 'prefer-dir', 'SKILL.md'), 'utf-8');
    expect(preferred).toContain('Directory should win');
  });
});
