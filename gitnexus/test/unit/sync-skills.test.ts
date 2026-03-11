/**
 * Unit Tests: Skill File Synchronization (TDD — Red Phase)
 *
 * Tests the `planSync` pure function that reads canonical skill files from
 * `gitnexus/skills/` and generates write operations for derived targets.
 *
 * See docs/skill-sync.md for the full specification.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { planSync, type SyncTarget, type SyncOperation } from '../../src/sync-skills.js';

// ─── Helpers ─────────────────────────────────────────────────────────

const CANONICAL_SKILLS = [
  'gitnexus-cli',
  'gitnexus-debugging',
  'gitnexus-exploring',
  'gitnexus-guide',
  'gitnexus-impact-analysis',
  'gitnexus-pr-review',
  'gitnexus-refactoring',
];

function makeFrontmatter(name: string, desc: string): string {
  return `---\nname: ${name}\ndescription: "${desc}"\n---\n`;
}

function makeSkillContent(name: string): string {
  return `${makeFrontmatter(name, `Description for ${name}`)}
# ${name}

Some body content here.

---

A horizontal rule above should not be stripped.
`;
}

/** Builds a mock readFile that serves files from a virtual filesystem. */
function mockReadFile(files: Record<string, string>): (p: string) => Promise<string> {
  return async (p: string) => {
    if (p in files) return files[p];
    throw Object.assign(new Error(`ENOENT: no such file or directory: '${p}'`), { code: 'ENOENT' });
  };
}

/** Builds a mock listDir that returns filenames from a virtual filesystem. */
function mockListDir(files: Record<string, string>): (dir: string) => Promise<string[]> {
  return async (dir: string) => {
    const normalized = dir.endsWith('/') ? dir : dir + '/';
    const entries = new Set<string>();
    for (const key of Object.keys(files)) {
      if (key.startsWith(normalized)) {
        const rest = key.slice(normalized.length);
        const name = rest.split('/')[0];
        if (name) entries.add(name);
      }
    }
    if (entries.size === 0 && !Object.keys(files).some(k => k.startsWith(normalized))) {
      throw Object.assign(new Error(`ENOENT: no such directory: '${dir}'`), { code: 'ENOENT' });
    }
    return [...entries].sort();
  };
}

function makeTarget(overrides: Partial<SyncTarget> & { name: string; dir: string }): SyncTarget {
  return {
    skills: CANONICAL_SKILLS,
    stripFrontmatter: true,
    generatedHeader: true,
    ...overrides,
  };
}

// ─── T1 — Source Discovery ───────────────────────────────────────────

describe('T1 — Source Discovery', () => {
  it('T1.1 — All .md files in sourceDir are discovered', async () => {
    const sourceDir = '/source';
    const files: Record<string, string> = {};
    for (const skill of CANONICAL_SKILLS) {
      files[`${sourceDir}/${skill}.md`] = makeSkillContent(skill);
    }

    const target = makeTarget({ name: 'test-target', dir: '/target' });
    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));

    expect(ops.length).toBe(CANONICAL_SKILLS.length);
    for (const skill of CANONICAL_SKILLS) {
      expect(ops.some(op => op.targetPath.includes(skill))).toBe(true);
    }
  });

  it('T1.2 — Non-skill .md files in source directory are ignored', async () => {
    const sourceDir = '/source';
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-debugging.md`]: makeSkillContent('gitnexus-debugging'),
      [`${sourceDir}/README.md`]: '# Readme',
      [`${sourceDir}/notes.txt`]: 'some notes',
    };

    const target = makeTarget({
      name: 'test-target',
      dir: '/target',
      skills: ['gitnexus-debugging'],
    });
    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));

    expect(ops.length).toBe(1);
    expect(ops[0].targetPath).toContain('gitnexus-debugging');
  });

  it('T1.3 — Empty source directory returns empty array', async () => {
    const sourceDir = '/empty';
    const files: Record<string, string> = {};
    // listDir returns [] for an existing but empty dir
    const listDir = async (_dir: string) => [] as string[];

    const target = makeTarget({ name: 'test-target', dir: '/target' });
    const ops = await planSync(sourceDir, [target], mockReadFile(files), listDir);

    expect(ops).toEqual([]);
  });

  it('T1.4 — Source directory does not exist throws descriptive error', async () => {
    const sourceDir = '/nonexistent';
    const files: Record<string, string> = {};
    const target = makeTarget({ name: 'test-target', dir: '/target' });

    await expect(
      planSync(sourceDir, [target], mockReadFile(files), mockListDir(files)),
    ).rejects.toThrow(/nonexistent/);
  });
});

// ─── T2 — Target Allowlist Filtering ─────────────────────────────────

describe('T2 — Target Allowlist Filtering', () => {
  const sourceDir = '/source';
  let files: Record<string, string>;

  function setup() {
    files = {};
    for (const skill of CANONICAL_SKILLS) {
      files[`${sourceDir}/${skill}.md`] = makeSkillContent(skill);
    }
  }

  it('T2.1 — Target with full allowlist receives all skills', async () => {
    setup();
    const target = makeTarget({
      name: 'full',
      dir: '/target-full',
      skills: [...CANONICAL_SKILLS],
    });
    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops.length).toBe(7);
  });

  it('T2.2 — Target with subset allowlist receives only listed skills', async () => {
    setup();
    const cursorSkills = [
      'gitnexus-debugging',
      'gitnexus-exploring',
      'gitnexus-impact-analysis',
      'gitnexus-refactoring',
      'gitnexus-pr-review',
    ];
    const target = makeTarget({
      name: 'cursor',
      dir: '/target-cursor',
      skills: cursorSkills,
    });
    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops.length).toBe(5);
    for (const skill of cursorSkills) {
      expect(ops.some(op => op.targetPath.includes(skill))).toBe(true);
    }
  });

  it('T2.3 — Allowlist references a skill not present in source throws or warns', async () => {
    setup();
    const target = makeTarget({
      name: 'bad',
      dir: '/target-bad',
      skills: ['gitnexus-nonexistent'],
    });

    await expect(
      planSync(sourceDir, [target], mockReadFile(files), mockListDir(files)),
    ).rejects.toThrow(/gitnexus-nonexistent/);
  });

  it('T2.4 — Empty allowlist produces no operations for that target', async () => {
    setup();
    const target = makeTarget({
      name: 'empty',
      dir: '/target-empty',
      skills: [],
    });
    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops.length).toBe(0);
  });

  it('T2.5 — Allowlist with duplicate entries deduplicates', async () => {
    setup();
    const target = makeTarget({
      name: 'dupes',
      dir: '/target-dupes',
      skills: ['gitnexus-debugging', 'gitnexus-debugging', 'gitnexus-debugging'],
    });
    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops.length).toBe(1);
  });
});

// ─── T3 — Content Transformation ────────────────────────────────────

describe('T3 — Content Transformation', () => {
  const sourceDir = '/source';

  it('T3.1 — Frontmatter stripping removes YAML block', async () => {
    const content = `---\nname: gitnexus-debugging\ndescription: "A skill"\n---\n\n# Body`;
    const files: Record<string, string> = { [`${sourceDir}/gitnexus-debugging.md`]: content };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
      stripFrontmatter: true,
      generatedHeader: false,
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops[0].content).not.toContain('---\nname:');
    expect(ops[0].content).toContain('# Body');
  });

  it('T3.2 — Frontmatter stripping with no frontmatter passes content through', async () => {
    const content = `# No frontmatter\n\nJust content.`;
    const files: Record<string, string> = { [`${sourceDir}/gitnexus-debugging.md`]: content };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
      stripFrontmatter: true,
      generatedHeader: false,
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops[0].content.trimEnd()).toContain('# No frontmatter');
    expect(ops[0].content).toContain('Just content.');
  });

  it('T3.3 — Frontmatter stripping preserves --- inside content body', async () => {
    const content = `---\nname: test\n---\n\n# Body\n\nSome text.\n\n---\n\nMore text after rule.`;
    const files: Record<string, string> = { [`${sourceDir}/gitnexus-debugging.md`]: content };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
      stripFrontmatter: true,
      generatedHeader: false,
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops[0].content).not.toMatch(/^---\nname:/);
    expect(ops[0].content).toContain('---\n\nMore text after rule.');
  });

  it('T3.4 — Generated header is prepended when configured', async () => {
    const content = makeSkillContent('gitnexus-debugging');
    const files: Record<string, string> = { [`${sourceDir}/gitnexus-debugging.md`]: content };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
      stripFrontmatter: true,
      generatedHeader: true,
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops[0].content).toMatch(
      /^<!-- AUTO-GENERATED FROM gitnexus\/skills\/gitnexus-debugging\.md .* DO NOT EDIT -->/,
    );
  });

  it('T3.5 — Generated header not added when disabled', async () => {
    const content = makeSkillContent('gitnexus-debugging');
    const files: Record<string, string> = { [`${sourceDir}/gitnexus-debugging.md`]: content };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
      stripFrontmatter: true,
      generatedHeader: false,
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops[0].content).not.toContain('AUTO-GENERATED');
  });

  it('T3.6 — Trailing whitespace is normalized (single newline at EOF)', async () => {
    const content = `---\nname: test\n---\n\n# Body\n\n\n\n`;
    const files: Record<string, string> = { [`${sourceDir}/gitnexus-debugging.md`]: content };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
      stripFrontmatter: true,
      generatedHeader: false,
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops[0].content).toMatch(/[^\n]\n$/);
  });
});

// ─── T4 — Path Generation ───────────────────────────────────────────

describe('T4 — Path Generation', () => {
  const sourceDir = '/source';

  it('T4.1 — Flat source produces {target}/{name}/SKILL.md', async () => {
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-debugging.md`]: makeSkillContent('gitnexus-debugging'),
    };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops[0].targetPath).toBe('/target/gitnexus-debugging/SKILL.md');
  });

  it('T4.2 — Skill name is extracted from filename', async () => {
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-impact-analysis.md`]: makeSkillContent('gitnexus-impact-analysis'),
    };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-impact-analysis'],
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops[0].targetPath).toContain('gitnexus-impact-analysis/SKILL.md');
  });

  it('T4.3 — Multiple targets produce independent paths', async () => {
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-debugging.md`]: makeSkillContent('gitnexus-debugging'),
    };
    const targets = [
      makeTarget({ name: 'claude', dir: '/target-claude', skills: ['gitnexus-debugging'] }),
      makeTarget({ name: 'plugin', dir: '/target-plugin', skills: ['gitnexus-debugging'] }),
      makeTarget({ name: 'cursor', dir: '/target-cursor', skills: ['gitnexus-debugging'] }),
    ];

    const ops = await planSync(sourceDir, targets, mockReadFile(files), mockListDir(files));
    expect(ops.length).toBe(3);

    const paths = ops.map(op => op.targetPath);
    expect(paths).toContain('/target-claude/gitnexus-debugging/SKILL.md');
    expect(paths).toContain('/target-plugin/gitnexus-debugging/SKILL.md');
    expect(paths).toContain('/target-cursor/gitnexus-debugging/SKILL.md');
  });
});

// ─── T5 — Idempotency and Skip Detection ────────────────────────────

describe('T5 — Idempotency and Skip Detection', () => {
  const sourceDir = '/source';
  const sourceContent = makeSkillContent('gitnexus-debugging');

  it('T5.1 — Content already matches target has action skip', async () => {
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-debugging.md`]: sourceContent,
    };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
    });

    // First run to get expected content
    const ops1 = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    const expectedContent = ops1[0].content;

    // Simulate that target already has the expected content
    const filesWithExisting = {
      ...files,
      ['/target/gitnexus-debugging/SKILL.md']: expectedContent,
    };

    const readFile = mockReadFile(filesWithExisting);
    const ops2 = await planSync(sourceDir, [target], readFile, mockListDir(files));
    expect(ops2[0].action).toBe('skip');
  });

  it('T5.2 — Content differs from target has action write', async () => {
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-debugging.md`]: sourceContent,
      ['/target/gitnexus-debugging/SKILL.md']: '# Old outdated content\n',
    };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops[0].action).toBe('write');
  });

  it('T5.3 — Target file does not exist yet has action write', async () => {
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-debugging.md`]: sourceContent,
    };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops[0].action).toBe('write');
  });

  it('T5.4 — Running sync twice produces zero writes on second run', async () => {
    const files: Record<string, string> = {};
    for (const skill of CANONICAL_SKILLS) {
      files[`${sourceDir}/${skill}.md`] = makeSkillContent(skill);
    }
    const target = makeTarget({ name: 'test', dir: '/target' });

    // First run: all writes
    const ops1 = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops1.every(op => op.action === 'write')).toBe(true);

    // Simulate applying writes — add generated content to virtual fs
    const updatedFiles = { ...files };
    for (const op of ops1) {
      updatedFiles[op.targetPath] = op.content;
    }

    // Second run: all skips
    const ops2 = await planSync(sourceDir, [target], mockReadFile(updatedFiles), mockListDir(files));
    expect(ops2.every(op => op.action === 'skip')).toBe(true);
  });
});

// ─── T6 — Companion File Preservation ───────────────────────────────

describe('T6 — Companion File Preservation', () => {
  const sourceDir = '/source';

  it('T6.1 — Existing mcp.json is not listed in operations', async () => {
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-debugging.md`]: makeSkillContent('gitnexus-debugging'),
      ['/target/gitnexus-debugging/mcp.json']: '{"mcpServers":{}}',
    };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops.every(op => op.targetPath.endsWith('SKILL.md'))).toBe(true);
  });

  it('T6.2 — No delete or overwrite operations for non-SKILL.md files', async () => {
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-debugging.md`]: makeSkillContent('gitnexus-debugging'),
      ['/target/gitnexus-debugging/mcp.json']: '{"mcpServers":{}}',
      ['/target/gitnexus-debugging/README.md']: '# Readme',
    };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    for (const op of ops) {
      expect(op.targetPath).not.toContain('mcp.json');
      expect(op.targetPath).not.toContain('README.md');
    }
  });
});

// ─── T7 — Error Handling ────────────────────────────────────────────

describe('T7 — Error Handling', () => {
  const sourceDir = '/source';

  it('T7.1 — Source file is unreadable throws with skill name and path', async () => {
    const listDir = async () => ['gitnexus-debugging.md'];
    const readFile = async (p: string) => {
      throw Object.assign(new Error(`EACCES: permission denied: '${p}'`), { code: 'EACCES' });
    };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
    });

    await expect(planSync(sourceDir, [target], readFile, listDir)).rejects.toThrow(
      /gitnexus-debugging/,
    );
  });

  it('T7.3 — Malformed YAML frontmatter (unclosed ---) is handled gracefully', async () => {
    const content = `---\nname: test\nno closing delimiter\n\n# Body content\n`;
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-debugging.md`]: content,
    };
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: ['gitnexus-debugging'],
      stripFrontmatter: true,
      generatedHeader: false,
    });

    // Should either treat entire content as body or throw with a clear message
    // We accept either behavior — the important thing is it doesn't silently corrupt content
    const result = planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    await expect(result).resolves.toBeDefined();
  });
});

// ─── T8 — Integration: Actual Repository State ─────────────────────

describe('T8 — Integration: Actual Repository State', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const sourceDir = path.join(repoRoot, 'skills');

  it('T8.1 — planSync against real gitnexus/skills/ returns expected operations', async () => {
    const target: SyncTarget = {
      name: 'integration-test',
      dir: '/tmp/sync-skills-test',
      skills: CANONICAL_SKILLS,
      stripFrontmatter: true,
      generatedHeader: true,
    };

    const readFile = (p: string) => fs.readFile(p, 'utf-8');
    const listDir = (dir: string) => fs.readdir(dir);
    const ops = await planSync(sourceDir, [target], readFile, listDir);

    expect(ops.length).toBe(CANONICAL_SKILLS.length);
  });

  it('T8.2 — All 7 canonical skills are present in source directory', async () => {
    const entries = await fs.readdir(sourceDir);
    const skillFiles = entries.filter(e => e.startsWith('gitnexus-') && e.endsWith('.md'));
    expect(skillFiles.length).toBe(7);
  });

  it('T8.3 — Skill names match expected set', async () => {
    const entries = await fs.readdir(sourceDir);
    const skillNames = entries
      .filter(e => e.startsWith('gitnexus-') && e.endsWith('.md'))
      .map(e => e.replace('.md', ''))
      .sort();

    expect(skillNames).toEqual(CANONICAL_SKILLS);
  });
});

// ─── T9 — SKILL_NAMES Parity ────────────────────────────────────────

describe('T9 — SKILL_NAMES Parity', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const sourceDir = path.join(repoRoot, 'skills');
  const setupPath = path.join(repoRoot, 'src', 'cli', 'setup.ts');

  it('T9.1 — Runtime SKILL_NAMES matches canonical source directory', async () => {
    // Read source skill names from filesystem
    const entries = await fs.readdir(sourceDir);
    const sourceSkills = entries
      .filter(e => e.startsWith('gitnexus-') && e.endsWith('.md'))
      .map(e => e.replace('.md', ''))
      .sort();

    // Read SKILL_NAMES from setup.ts source
    const setupContent = await fs.readFile(setupPath, 'utf-8');
    const match = setupContent.match(/SKILL_NAMES\s*=\s*\[([^\]]+)\]/);
    expect(match).not.toBeNull();

    const runtimeSkills = match![1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, ''))
      .filter(s => s.length > 0)
      .sort();

    expect(runtimeSkills).toEqual(sourceSkills);
  });

  it('T9.2 — Detects if SKILL_NAMES is missing a skill present in source', async () => {
    const entries = await fs.readdir(sourceDir);
    const sourceSkills = entries
      .filter(e => e.startsWith('gitnexus-') && e.endsWith('.md'))
      .map(e => e.replace('.md', ''));

    const setupContent = await fs.readFile(setupPath, 'utf-8');
    const match = setupContent.match(/SKILL_NAMES\s*=\s*\[([^\]]+)\]/);
    const runtimeSkills = match![1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, ''))
      .filter(s => s.length > 0);

    for (const skill of sourceSkills) {
      expect(runtimeSkills, `SKILL_NAMES is missing ${skill}`).toContain(skill);
    }
  });
});

// ─── T10 — Manifest Validation ──────────────────────────────────────

describe('T10 — Manifest Validation', () => {
  // These tests validate the manifest parsing logic that will be part of the sync script.
  // For now we test `planSync` with inline SyncTarget configs. When Phase 3 adds manifest
  // file loading, these tests will ensure the parser rejects invalid manifests.

  it('T10.1 — Valid manifest parses correctly', async () => {
    const manifest = { skills: ['gitnexus-debugging', 'gitnexus-exploring'] };
    const sourceDir = '/source';
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-debugging.md`]: makeSkillContent('gitnexus-debugging'),
      [`${sourceDir}/gitnexus-exploring.md`]: makeSkillContent('gitnexus-exploring'),
    };

    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: manifest.skills,
    });

    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops.length).toBe(2);
  });

  it('T10.2 — Manifest with unknown fields is accepted (forward-compat)', async () => {
    const manifest = {
      skills: ['gitnexus-debugging'],
      version: '2.0',
      author: 'unknown',
    };
    const sourceDir = '/source';
    const files: Record<string, string> = {
      [`${sourceDir}/gitnexus-debugging.md`]: makeSkillContent('gitnexus-debugging'),
    };

    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: manifest.skills,
    });

    // Should work fine — extra fields are ignored at the SyncTarget level
    const ops = await planSync(sourceDir, [target], mockReadFile(files), mockListDir(files));
    expect(ops.length).toBe(1);
  });

  it('T10.3 — Manifest with missing skills field throws descriptive error', async () => {
    const badManifest = { version: '1.0' } as any;
    const sourceDir = '/source';
    const files: Record<string, string> = {};

    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: badManifest.skills, // undefined
    });

    await expect(
      planSync(sourceDir, [target], mockReadFile(files), mockListDir(files)),
    ).rejects.toThrow();
  });

  it('T10.4 — Manifest is not valid JSON throws with path in error message', async () => {
    // This test validates the manifest file parser (to be implemented in Phase 3).
    // For now we verify planSync rejects a target with an invalid skills value.
    const target = makeTarget({
      name: 'test',
      dir: '/target',
      skills: null as any,
    });

    await expect(
      planSync('/source', [target], mockReadFile({}), mockListDir({})),
    ).rejects.toThrow();
  });
});
