import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { generateAIContextFiles } from '../../src/cli/ai-context.js';

describe('generateAIContextFiles', () => {
  let tmpDir: string;
  let storagePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-test-'));
    storagePath = path.join(tmpDir, '.gitnexus');
    await fs.mkdir(storagePath, { recursive: true });
  });

  afterEach(async () => {
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

  it('does NOT install skills after refactor', async () => {
    const stats = { nodes: 10 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const skillsDir = path.join(tmpDir, '.claude', 'skills', 'gitnexus');
    await expect(fs.stat(skillsDir)).rejects.toThrow();
  });

  it('return value does not mention skills after refactor', async () => {
    const stats = { nodes: 10 };
    const result = await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);
    const skillFiles = result.files.filter((f) => f.includes('skills'));
    expect(skillFiles).toHaveLength(0);
  });

  it('preserves existing CLAUDE.md content', async () => {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    await fs.writeFile(claudePath, '# My Custom Instructions\n\nDo not remove this.\n', 'utf-8');

    const stats = { nodes: 10 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(claudePath, 'utf-8');
    expect(content).toContain('My Custom Instructions');
    expect(content).toContain('Do not remove this.');
    expect(content).toContain('gitnexus:start');
  });

  it('existing CLAUDE.md with gitnexus section but no skills dir works', async () => {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    await fs.writeFile(
      claudePath,
      '<!-- gitnexus:start -->\nold content\n<!-- gitnexus:end -->\n',
      'utf-8',
    );

    const stats = { nodes: 99 };
    await generateAIContextFiles(tmpDir, storagePath, 'UpdatedProject', stats);

    const content = await fs.readFile(claudePath, 'utf-8');
    expect(content).not.toContain('old content');
    expect(content).toContain('99 symbols');
    const starts = (content.match(/gitnexus:start/g) || []).length;
    expect(starts).toBe(1);
    await expect(fs.stat(path.join(tmpDir, '.claude', 'skills', 'gitnexus'))).rejects.toThrow();
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
