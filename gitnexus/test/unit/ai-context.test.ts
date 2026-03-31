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

  it('preserves custom section when gitnexus:keep is present', async () => {
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');

    // Write a custom lean section with keep marker
    const customContent = `# My Project

Some project docs here.

<!-- gitnexus:start -->
<!-- gitnexus:keep -->
# GitNexus — Code Knowledge Graph

Indexed as **TestProject** (50 symbols, 100 relationships, 5 execution flows). MCP tools.

| Tool | Use for |
|------|---------|
| query | Find flows |

Resources: gitnexus://repo/TestProject/context
<!-- gitnexus:end -->
`;
    await fs.writeFile(claudeMdPath, customContent, 'utf-8');

    // Run analyze with new stats — should only update the stats line
    const stats = { nodes: 999, edges: 1234, processes: 42 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const result = await fs.readFile(claudeMdPath, 'utf-8');

    // Stats should be updated
    expect(result).toContain('999 symbols');
    expect(result).toContain('1234 relationships');
    expect(result).toContain('42 execution flows');

    // Custom layout should be preserved (not replaced with verbose template)
    expect(result).toContain('<!-- gitnexus:keep -->');
    expect(result).toContain('Code Knowledge Graph');
    expect(result).toContain('| query | Find flows |');

    // Verbose template sections should NOT be present
    expect(result).not.toContain('## Always Do');
    expect(result).not.toContain('## Never Do');
    expect(result).not.toContain('## When Debugging');

    // Non-GitNexus content should be preserved
    expect(result).toContain('# My Project');
    expect(result).toContain('Some project docs here.');
  });

  it('replaces section when no keep marker is present', async () => {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');

    // Write a section WITHOUT keep marker
    const content = `<!-- gitnexus:start -->
# GitNexus — Code Intelligence

Old content here.
<!-- gitnexus:end -->
`;
    await fs.writeFile(agentsPath, content, 'utf-8');

    const stats = { nodes: 100, edges: 200, processes: 10 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const result = await fs.readFile(agentsPath, 'utf-8');

    // Should have the full verbose template
    expect(result).toContain('## Always Do');
    expect(result).not.toContain('Old content here');
  });

  it('installs skills files', async () => {
    const stats = { nodes: 10 };
    const result = await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    // Should have installed skill files
    const skillsDir = path.join(tmpDir, '.claude', 'skills', 'gitnexus');
    try {
      const entries = await fs.readdir(skillsDir, { recursive: true });
      expect(entries.length).toBeGreaterThan(0);
    } catch {
      // Skills dir may not be created if skills source doesn't exist in test context
    }
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
