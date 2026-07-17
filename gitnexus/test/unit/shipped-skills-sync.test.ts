import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RENAMED_SKILL_DIRS } from '../../src/cli/setup.js';

// The engineering skill family is authored once under .claude/skills/ and
// shipped as byte-identical copies through the npm package's skills/ directory
// (installed to editor targets by `gitnexus setup`) and the Claude Code plugin
// (which adds only a per-skill mcp.json). gitnexus-review is also mirrored by
// the standalone Cursor integration.
// This test is the drift guard — edit the .claude/skills/ copy and re-copy;
// never edit a shipped copy directly. Same discipline as run.cjs ↔
// resolve-invocation.ts.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FAMILY = ['gitnexus-plan', 'gitnexus-work', 'gitnexus-review', 'gitnexus-lfg'];

function listFilesRecursive(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else {
      out.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return out.sort();
}

function snapshotDir(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const rel of listFilesRecursive(dir)) {
    snapshot[rel] = fs.readFileSync(path.join(dir, rel), 'utf-8');
  }
  return snapshot;
}

describe.each(FAMILY)('shipped copies of %s stay in sync', (name) => {
  const canonical = snapshotDir(path.join(REPO_ROOT, '.claude', 'skills', name));

  it('npm package copy (gitnexus/skills/) is byte-identical', () => {
    const shipped = snapshotDir(path.join(REPO_ROOT, 'gitnexus', 'skills', name));
    expect(shipped).toEqual(canonical);
  });

  it('plugin copy (gitnexus-claude-plugin/skills/) is canonical + mcp.json only', () => {
    const plugin = snapshotDir(path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills', name));
    const guideMcp = fs.readFileSync(
      path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills', 'gitnexus-guide', 'mcp.json'),
      'utf-8',
    );
    expect(plugin).toEqual({ ...canonical, 'mcp.json': guideMcp });
  });
});

describe('standalone Cursor review skill stays in sync', () => {
  it('is byte-identical to the canonical gitnexus-review skill', () => {
    const canonical = snapshotDir(path.join(REPO_ROOT, '.claude', 'skills', 'gitnexus-review'));
    const cursor = snapshotDir(
      path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'skills', 'gitnexus-review'),
    );
    expect(cursor).toEqual(canonical);
  });
});

describe('gitnexus-review target contract', () => {
  const skill = fs.readFileSync(
    path.join(REPO_ROOT, '.claude', 'skills', 'gitnexus-review', 'SKILL.md'),
    'utf-8',
  );

  it.each(['PR URL', 'base...head', 'Branch, tag, or commit', 'Local changes'])(
    'documents the %s target mode',
    (targetMode) => {
      expect(skill).toContain(targetMode);
    },
  );

  it('uses the generalized public skill name', () => {
    expect(skill).toContain('name: gitnexus-review');
    expect(skill).not.toContain('name: gitnexus-pr-review');
  });
});

// ── Resurrection guard ──
// A skill's OLD directory name must never reappear in a shipped tree: setup
// would install it again alongside the new name, and the rename warning in
// setup.ts would point at a dir we ourselves shipped. Empty directories are
// treated as absent (checkout residue can leave empty dirs on disk locally),
// so the assertion is "no files inside", not fs.existsSync of the dir.
const filesUnder = (dir: string): string[] => (fs.existsSync(dir) ? listFilesRecursive(dir) : []);

describe.each(Object.values(RENAMED_SKILL_DIRS).flat())(
  'legacy skill name %s stays out of the shipped trees',
  (legacyName) => {
    it.each([
      path.join(REPO_ROOT, '.claude', 'skills'),
      path.join(REPO_ROOT, 'gitnexus', 'skills'),
      path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills'),
      path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'skills'),
    ])('has no files under %s', (skillsRoot) => {
      expect(filesUnder(path.join(skillsRoot, legacyName))).toEqual([]);
    });

    it('has no flat copy in the npm package skills root', () => {
      expect(fs.existsSync(path.join(REPO_ROOT, 'gitnexus', 'skills', `${legacyName}.md`))).toBe(
        false,
      );
    });
  },
);
