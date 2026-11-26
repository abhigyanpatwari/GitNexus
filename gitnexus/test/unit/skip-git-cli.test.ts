import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';

describe('--skip-git CLI flag', () => {
  const cliPath = path.resolve(__dirname, '../../dist/cli/index.js');
  it('Commander maps --skip-git to options.skipGit (not --no-git inversion)', () => {
    // Verify the CLI defines --skip-git and --skip-agents-md in analyze help.
    const helpOutput = execSync(`node "${cliPath}" analyze --help`, {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, GITNEXUS_LANG: 'en' },
    });

    expect(helpOutput).toContain('--skip-git');
    const helpFlat = helpOutput.replace(/\s+/g, ' ');
    expect(helpFlat).toContain('--skip-agents-md');
    expect(helpFlat).toContain('Does not skip standard skills in .claude/skills');
    expect(helpFlat).toContain('Community skills from --skills are unaffected');
    expect(helpFlat).toContain('--skip-skills');
    expect(helpOutput).toContain('directly under .claude/skills/');
    expect(helpOutput).toContain('.agents/skills/');
    expect(helpOutput).toContain('.claude/skills/gitnexus-area-*');
    expect(helpOutput).toContain('--index-only');
    expect(helpOutput).not.toContain('--no-git');
  });
});
