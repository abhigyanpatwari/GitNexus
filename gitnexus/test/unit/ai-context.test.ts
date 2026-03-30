import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { generateAIContextFiles } from '../../src/cli/ai-context.js';

describe('generateAIContextFiles', () => {
  let tmpDir: string;
  let storagePath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-test-'));
    storagePath = path.join(tmpDir, '.gitnexus');
    await fs.mkdir(storagePath, { recursive: true });
  });

  afterAll(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('generates context files', async () => {
    const stats = {
      nodes: 100,
      edges: 200,
      processes: 10,
    };

    const result = await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);
    expect(result.files).toBeDefined();
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('creates or updates CLAUDE.md with GitNexus section', async () => {
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const content = await fs.readFile(claudeMdPath, 'utf-8');
    expect(content).toContain('gitnexus:start');
    expect(content).toContain('gitnexus:end');
    expect(content).toContain('TestProject');
  });

  it('handles empty stats', async () => {
    const stats = {};
    const result = await generateAIContextFiles(tmpDir, storagePath, 'EmptyProject', stats);
    expect(result.files).toBeDefined();
  });

  it('updates existing CLAUDE.md without duplicating', async () => {
    const stats = { nodes: 10 };

    // Run twice
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const content = await fs.readFile(claudeMdPath, 'utf-8');

    // Should only have one gitnexus section
    const starts = (content.match(/gitnexus:start/g) || []).length;
    expect(starts).toBe(1);
  });

  it('replaces only the managed GitNexus block when marker text appears in prose', async () => {
    const stats = { nodes: 10 };
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');

    await fs.writeFile(
      claudeMdPath,
      [
        '# CLAUDE',
        '',
        'GitNexus MCP rules are in the `<!-- gitnexus:start -->` ... `<!-- gitnexus:end -->` block in AGENTS.md.',
        '',
        '<!-- gitnexus:start -->',
        'old managed block',
        '<!-- gitnexus:end -->',
        '',
      ].join('\n'),
      'utf-8',
    );

    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(claudeMdPath, 'utf-8');
    expect(content).toContain(
      'GitNexus MCP rules are in the `<!-- gitnexus:start -->` ... `<!-- gitnexus:end -->` block in AGENTS.md.',
    );
    expect(content).not.toContain('old managed block');
    expect((content.match(/gitnexus:start/g) || []).length).toBe(2);
  });

  it('installs bundled skills as flat Claude skills', async () => {
    const stats = { nodes: 10 };
    const result = await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    expect(result.files).toContain('.claude/skills/ (6 skills)');

    const skillPath = path.join(tmpDir, '.claude', 'skills', 'gitnexus-exploring', 'SKILL.md');
    const nestedSkillPath = path.join(
      tmpDir,
      '.claude',
      'skills',
      'gitnexus',
      'gitnexus-exploring',
      'SKILL.md',
    );

    expect(await fs.readFile(skillPath, 'utf-8')).toContain('# Exploring Codebases with GitNexus');
    await expect(fs.access(nestedSkillPath)).rejects.toThrow();
  });

  it('removes legacy nested skill directories when installing flat Claude skills', async () => {
    const stats = { nodes: 10 };
    const legacyBundledPath = path.join(
      tmpDir,
      '.claude',
      'skills',
      'gitnexus',
      'gitnexus-exploring',
      'SKILL.md',
    );
    const legacyGeneratedPath = path.join(
      tmpDir,
      '.claude',
      'skills',
      'generated',
      'legacy-area',
      'SKILL.md',
    );

    await fs.mkdir(path.dirname(legacyBundledPath), { recursive: true });
    await fs.mkdir(path.dirname(legacyGeneratedPath), { recursive: true });
    await fs.writeFile(legacyBundledPath, 'legacy bundled', 'utf-8');
    await fs.writeFile(legacyGeneratedPath, 'legacy generated', 'utf-8');

    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    await expect(fs.access(legacyBundledPath)).rejects.toThrow();
    await expect(fs.access(legacyGeneratedPath)).rejects.toThrow();
  });

  it('preserves manual AGENTS.md and CLAUDE.md edits when skipAgentsMd is enabled', async () => {
    const stats = { nodes: 42, edges: 84, processes: 3 };
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const agentsContent = '# AGENTS\n\nCustom manual instructions only\n';
    const claudeContent = '# CLAUDE\n\nCustom manual instructions only\n';

    await fs.writeFile(agentsPath, agentsContent, 'utf-8');
    await fs.writeFile(claudePath, claudeContent, 'utf-8');

    const result = await generateAIContextFiles(
      tmpDir,
      storagePath,
      'TestProject',
      stats,
      undefined,
      { skipAgentsMd: true },
    );

    expect(result.files).toContain('AGENTS.md (skipped via --skip-agents-md)');
    expect(result.files).toContain('CLAUDE.md (skipped via --skip-agents-md)');

    const agentsAfter = await fs.readFile(agentsPath, 'utf-8');
    const claudeAfter = await fs.readFile(claudePath, 'utf-8');
    expect(agentsAfter).toBe(agentsContent);
    expect(claudeAfter).toBe(claudeContent);
  });
});
