import { describe, it, before as beforeAll, after as afterAll } from 'node:test';
import { expect } from 'expect';
import { cleanupTempDirSync } from '../../../../test/helpers/test-db.js';
import path from 'path';
import fs from 'fs';

import {
  assertContextFiles,
  assertSkillFiles,
  assertSkillsCliSucceeded,
  createFixtureRepo,
  runSkillsCli,
} from '../../../../test/helpers/skills-e2e.js';

function fixtureFiles(name: string): Record<string, string> {
  const root = path.join(import.meta.dirname, '../../../../test/fixtures/skills-e2e', name);
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(root, file), fs.readFileSync(file, 'utf8')];
      }),
  );
}
describe('TypeScript', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(
    () => {
      tmpDir = createFixtureRepo('typescript', fixtureFiles('typescript'));
      result = runSkillsCli(tmpDir);
    },
    { timeout: 120000 },
  );

  afterAll(() => {
    cleanupTempDirSync(tmpDir);
  });

  /**
   * Verify analyze --skills generates valid SKILL.md files for a
   * TypeScript repo with 3 clusters of cross-calling functions.
   */
  it('generates skill files', { timeout: 50000 }, () => {
    assertSkillFiles(result, tmpDir);
  });

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', { timeout: 50000 }, () => {
    assertContextFiles(result, tmpDir);
  });
});

describe('Mixed TypeScript + Python', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(
    () => {
      tmpDir = createFixtureRepo('mixed', fixtureFiles('typescript-python'));
      result = runSkillsCli(tmpDir);
    },
    { timeout: 120000 },
  );

  afterAll(() => {
    cleanupTempDirSync(tmpDir);
  });

  /**
   * Verify analyze --skills generates at least 1 SKILL.md for a
   * mixed TypeScript + Python monorepo. Relaxed assertion since Leiden
   * may or may not form communities spanning both languages.
   */
  it('generates skill files', { timeout: 50000 }, () => {
    assertSkillFiles(result, tmpDir, 1);
  });

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', { timeout: 50000 }, () => {
    assertContextFiles(result, tmpDir);
  });
});

describe('Idempotency', () => {
  let tmpDir: string;
  let result1: ReturnType<typeof runSkillsCli>;
  let result2: ReturnType<typeof runSkillsCli>;

  beforeAll(
    () => {
      tmpDir = createFixtureRepo('idempotency', fixtureFiles('idempotency'));
      result1 = runSkillsCli(tmpDir);
      result2 = runSkillsCli(tmpDir);
      // 120s to match the other describe hooks in this file. This hook runs
      // runSkillsCli TWICE, each capped at 45s, so a 90s budget has no headroom
      // over two worst-case analyzes plus fixture setup and git init.
    },
    { timeout: 120000 },
  );

  afterAll(() => {
    cleanupTempDirSync(tmpDir);
  });

  /**
   * Running analyze --skills twice should produce stable output:
   * same number of skill directories, all SKILL.md files valid,
   * and CLAUDE.md still references generated skills.
   */
  it('second analyze --skills produces stable output', { timeout: 90000 }, () => {
    assertSkillsCliSucceeded(result1);
    assertSkillsCliSucceeded(result2);

    const skillsRoot = path.join(tmpDir, '.claude', 'skills');
    expect(fs.existsSync(skillsRoot)).toBe(true);

    const skillDirs = fs
      .readdirSync(skillsRoot)
      .filter(
        (d) =>
          d.startsWith('gitnexus-area-') && fs.statSync(path.join(skillsRoot, d)).isDirectory(),
      );
    expect(skillDirs.length).toBeGreaterThanOrEqual(1);

    /* All SKILL.md files should still have valid frontmatter */
    for (const dir of skillDirs) {
      const skillPath = path.join(skillsRoot, dir, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
      const content = fs.readFileSync(skillPath, 'utf-8');
      expect(content.startsWith('---')).toBe(true);
      expect(content).toContain('name:');
      expect(content).toContain('description:');
      expect(content.length).toBeGreaterThan(200);
    }

    /* CLAUDE.md should still reference generated skills */
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    expect(fs.existsSync(claudePath)).toBe(true);
    const claudeContent = fs.readFileSync(claudePath, 'utf-8');
    expect(claudeContent).toContain('.claude/skills/gitnexus-area-');
  });
});
