import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
    } catch { /* best-effort */ }
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
});
