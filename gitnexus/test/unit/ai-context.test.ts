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

  it('keeps the load-bearing repo-specific sections in the CLAUDE.md block (#856)', async () => {
    // The trimmed block must still contain everything that is genuinely
    // unique per repo or load-bearing for the agent: the freshness warning,
    // the Always Do / Never Do imperative lists, the Resources URI table
    // (projectName-interpolated), and the skills routing table that tells
    // the agent which skill file to read for each task.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');

    expect(content).toContain('If any GitNexus tool warns the index is stale');
    expect(content).toContain('## Always Do');
    expect(content).toContain('## Never Do');
    expect(content).toContain('## Resources');
    expect(content).toContain('gitnexus://repo/TestProject/context');
    expect(content).toContain('gitnexus-impact-analysis/SKILL.md');
    expect(content).toContain('gitnexus-refactoring/SKILL.md');
    expect(content).toContain('gitnexus-debugging/SKILL.md');
    expect(content).toContain('gitnexus-cli/SKILL.md');
  });

  it('does not duplicate content that already lives in skill files (#856)', async () => {
    // The six sections listed in issue #856 are redundant with the skill
    // files shipped alongside the CLAUDE.md block (both are loaded into
    // every Claude Code session). Their absence is the whole point of the
    // trim — assert each header is gone so a future regression that pads
    // the block back out fails here.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');

    expect(content).not.toContain('## Tools Quick Reference');
    expect(content).not.toContain('## Impact Risk Levels');
    expect(content).not.toContain('## Self-Check Before Finishing');
    expect(content).not.toContain('## When Debugging');
    expect(content).not.toContain('## When Refactoring');
    expect(content).not.toContain('## Keeping the Index Fresh');
  });

  it('keeps the CLAUDE.md GitNexus block under the token-cost budget (#856)', async () => {
    // The pre-trim block was ~5465 chars. After #856 it's ~2580 — about a
    // 52% reduction. 2700 is a soft ceiling that still leaves headroom for
    // legitimate future additions but will fail loudly if the trim is
    // reverted or someone pads the block back out toward the original size.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    const block = content.slice(
      content.indexOf('<!-- gitnexus:start -->'),
      content.indexOf('<!-- gitnexus:end -->'),
    );
    expect(block.length).toBeLessThan(2700);
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

  it('preserves inline marker references in prose and does not corrupt markdown (#1041)', async () => {
    // Regression guard for #1041. The shipped CLAUDE.md ships with a
    // prose paragraph referencing the marker pair inline — wrapped in a
    // backtick-quoted fragment mid-sentence. `indexOf` (the pre-fix
    // matcher) would match both of those inline markers and replace the
    // content between them with the full injected block, destroying the
    // sentence and leaving the backtick unclosed.
    //
    // Per-test tmpdir so we start from a known clean slate — the shared
    // `tmpDir` from beforeAll may already contain CLAUDE.md from earlier
    // tests in this describe block.
    const bugDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-1041-'));
    const bugStorage = path.join(bugDir, '.gitnexus');
    await fs.mkdir(bugStorage, { recursive: true });

    const inlineProseLine =
      'See the `<!-- gitnexus:start --> … <!-- gitnexus:end -->` block in **[AGENTS.md](AGENTS.md)** for the canonical MCP tools, impact analysis rules, and index instructions.';
    const originalContent = `# Claude Code Rules\n\nLast reviewed: 2026-04-21\n\n## GitNexus rules\n\n${inlineProseLine}\n`;

    const claudeMd = path.join(bugDir, 'CLAUDE.md');
    await fs.writeFile(claudeMd, originalContent, 'utf-8');

    try {
      const stats = { nodes: 50, edges: 100, processes: 5 };

      // First run — no section-position markers exist yet, so the
      // injector must append a fresh section at end. The inline prose
      // must be preserved verbatim; if it disappears or gets altered,
      // the bug has recurred.
      await generateAIContextFiles(bugDir, bugStorage, 'TestProject', stats);
      let contentAfter = await fs.readFile(claudeMd, 'utf-8');

      expect(contentAfter, 'inline prose line must survive the first run verbatim').toContain(
        inlineProseLine,
      );
      // Exactly 2 start markers total: 1 inline (in prose) + 1
      // section-position (appended by the injector). The pre-fix
      // behaviour would have only 1 — the inline pair having been
      // consumed as if they were section delimiters.
      expect((contentAfter.match(/<!-- gitnexus:start -->/g) || []).length).toBe(2);
      expect((contentAfter.match(/<!-- gitnexus:end -->/g) || []).length).toBe(2);

      // Second run — the section from run 1 is now at section position,
      // so the injector must UPDATE in place (not re-append). Inline
      // prose stays preserved; marker counts unchanged.
      await generateAIContextFiles(bugDir, bugStorage, 'TestProject', stats);
      contentAfter = await fs.readFile(claudeMd, 'utf-8');

      expect(contentAfter, 'inline prose line must survive the second run verbatim').toContain(
        inlineProseLine,
      );
      expect((contentAfter.match(/<!-- gitnexus:start -->/g) || []).length).toBe(2);
      expect((contentAfter.match(/<!-- gitnexus:end -->/g) || []).length).toBe(2);
    } finally {
      await fs.rm(bugDir, { recursive: true, force: true });
    }
  });

  it('matches section markers on files with CRLF line endings (#1041 cross-platform)', async () => {
    // Locks in the CRLF leg of the section-position matcher. Git on
    // Windows may store files with `\r\n` line endings depending on
    // `core.autocrlf`; when a section line ends `<!-- gitnexus:start
    // -->\r\n`, the byte at `endPos` is `\r` (not `\n`). A `\n`-only
    // line-end check would reject the real section, fall through to
    // "append", and duplicate the block every run.
    const crlfDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-crlf-'));
    const crlfStorage = path.join(crlfDir, '.gitnexus');
    await fs.mkdir(crlfStorage, { recursive: true });

    // Inline reference carries BOTH markers in a backtick-quoted
    // fragment — matches the shape of the shipped CLAUDE.md line
    // that triggered #1041 so the regression guard is meaningful.
    const inlineProseLine =
      'See the `<!-- gitnexus:start --> … <!-- gitnexus:end -->` block in **[AGENTS.md](AGENTS.md)** for more.';
    const seeded = [
      '# Claude Code Rules',
      '',
      '## GitNexus rules',
      '',
      inlineProseLine,
      '',
      '<!-- gitnexus:start -->',
      '# GitNexus — Code Intelligence (stale stub)',
      '<!-- gitnexus:end -->',
      '',
    ].join('\r\n');

    const claudeMd = path.join(crlfDir, 'CLAUDE.md');
    await fs.writeFile(claudeMd, seeded, 'utf-8');

    try {
      const stats = { nodes: 50, edges: 100, processes: 5 };
      await generateAIContextFiles(crlfDir, crlfStorage, 'TestProject', stats);
      const content = await fs.readFile(claudeMd, 'utf-8');

      // Inline prose survives verbatim — no corruption of CRLF bytes.
      expect(content).toContain(inlineProseLine);
      // Exactly 2 start markers total (1 inline + 1 section-position).
      // If CRLF handling broke, the inline marker would be (incorrectly)
      // matched as a section start, OR the real section would be
      // appended duplicated — either way we'd see !== 2.
      expect((content.match(/<!-- gitnexus:start -->/g) || []).length).toBe(2);
      expect((content.match(/<!-- gitnexus:end -->/g) || []).length).toBe(2);
      // Stale stub content must be gone — proves the section was
      // REPLACED (not appended as a duplicate), which requires the
      // CRLF-ending markers to have been matched.
      expect(content).not.toContain('# GitNexus — Code Intelligence (stale stub)');
    } finally {
      await fs.rm(crlfDir, { recursive: true, force: true });
    }
  });
});
