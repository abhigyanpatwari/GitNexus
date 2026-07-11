import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The engineering skill family is authored once under .claude/skills/ and
// shipped as byte-identical copies through two channels: the npm package's
// skills/ dir (installSkillsTo copies it to editor targets on `gitnexus
// setup`) and the Claude Code plugin (which adds only a per-skill mcp.json).
// This test is the drift guard — edit the .claude/skills/ copy and re-copy;
// never edit a shipped copy directly. Same discipline as run.cjs ↔
// resolve-invocation.ts.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FAMILY = ['gitnexus-plan', 'gitnexus-work', 'gitnexus-lfg'];

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
