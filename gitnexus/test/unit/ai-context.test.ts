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

  it('omits volatile counts when noStats option is set (#1477)', async () => {
    // Distinct subdir per case so we can assert on a clean slate.
    const subDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-no-stats-test-'));
    const subStorage = path.join(subDir, '.gitnexus');
    await fs.mkdir(subStorage, { recursive: true });
    try {
      // Stats values picked to be unmistakable if they leak through.
      const stats = { nodes: 12345, edges: 67890, processes: 99 };
      await generateAIContextFiles(subDir, subStorage, 'NoStatsProject', stats, undefined, {
        noStats: true,
      });

      for (const f of ['CLAUDE.md', 'AGENTS.md']) {
        const content = await fs.readFile(path.join(subDir, f), 'utf-8');
        expect(content).toContain('NoStatsProject');
        // The "(N symbols, N relationships, N execution flows)"
        // phrase MUST NOT appear when noStats=true.
        expect(content).not.toMatch(
          /\(\d+\s+symbols,\s+\d+\s+relationships,\s+\d+\s+execution flows\)/,
        );
        // And the distinctive numbers must not leak via any other path.
        expect(content).not.toContain('12345');
        expect(content).not.toContain('67890');
      }
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it('preserves volatile counts when noStats is not set (default)', async () => {
    const subDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-with-stats-test-'));
    const subStorage = path.join(subDir, '.gitnexus');
    await fs.mkdir(subStorage, { recursive: true });
    try {
      const stats = { nodes: 12345, edges: 67890, processes: 99 };
      await generateAIContextFiles(subDir, subStorage, 'WithStatsProject', stats);
      for (const f of ['CLAUDE.md', 'AGENTS.md']) {
        const content = await fs.readFile(path.join(subDir, f), 'utf-8');
        expect(content).toContain('WithStatsProject');
        expect(content).toMatch(
          /\(12345\s+symbols,\s+67890\s+relationships,\s+99\s+execution flows\)/,
        );
      }
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
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
    expect(result).toContain('. MCP tools.');

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
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    // Should have installed skill files
    const skillsDir = path.join(tmpDir, '.claude', 'skills', 'gitnexus');
    try {
      const entries = await fs.readdir(skillsDir, { recursive: true });
      expect(entries.length).toBeGreaterThan(0);
    } catch {
      // Skills dir may not be created if skills source doesn't exist in test context
    }
  });

  it('does not create .claude/skills/gitnexus/ when skipSkills is true (#742)', async () => {
    // Regression guard for #742. The --skip-skills flag must prevent
    // installSkills() from writing the 6 standard skill dirs into the
    // analyzed repo. Per-test tmpdir so we start from a known-clean
    // slate — the shared tmpDir from beforeAll may already contain
    // .claude/skills/gitnexus/ from an earlier test.
    const skipDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-skip-skills-'));
    const skipStorage = path.join(skipDir, '.gitnexus');
    await fs.mkdir(skipStorage, { recursive: true });
    try {
      const stats = { nodes: 50, edges: 100, processes: 5 };
      const result = await generateAIContextFiles(
        skipDir,
        skipStorage,
        'TestProject',
        stats,
        undefined,
        { skipSkills: true },
      );

      expect(result.files).toContain('.claude/skills/gitnexus/ (skipped via --skip-skills)');
      await expect(
        fs.access(path.join(skipDir, '.claude', 'skills', 'gitnexus')),
      ).rejects.toThrow();
    } finally {
      await fs.rm(skipDir, { recursive: true, force: true });
    }
  });

  it('writes nothing when both skipAgentsMd and skipSkills are true (--index-only, #742)', async () => {
    // Regression guard for #742. analyzeCommand() resolves --index-only
    // into BOTH skipAgentsMd=true and skipSkills=true. This test pins
    // the resolved-flag combination so a future regression that drops
    // either guard fails here. Per-test tmpdir for the same reason as
    // the skipSkills test above.
    const idxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-index-only-'));
    const idxStorage = path.join(idxDir, '.gitnexus');
    await fs.mkdir(idxStorage, { recursive: true });
    try {
      const stats = { nodes: 50, edges: 100, processes: 5 };
      const result = await generateAIContextFiles(
        idxDir,
        idxStorage,
        'TestProject',
        stats,
        undefined,
        { skipAgentsMd: true, skipSkills: true },
      );

      expect(result.files).toContain('AGENTS.md (skipped via --skip-agents-md)');
      expect(result.files).toContain('CLAUDE.md (skipped via --skip-agents-md)');
      expect(result.files).toContain('.claude/skills/gitnexus/ (skipped via --skip-skills)');

      await expect(fs.access(path.join(idxDir, 'AGENTS.md'))).rejects.toThrow();
      await expect(fs.access(path.join(idxDir, 'CLAUDE.md'))).rejects.toThrow();
      await expect(fs.access(path.join(idxDir, '.claude', 'skills', 'gitnexus'))).rejects.toThrow();
    } finally {
      await fs.rm(idxDir, { recursive: true, force: true });
    }
  });

  it('omits standard skill references from AGENTS.md/CLAUDE.md when skipSkills is true (#742)', async () => {
    // The skills routing table in AGENTS.md/CLAUDE.md points agents at
    // .claude/skills/gitnexus/*/SKILL.md files installed by installSkills().
    // When --skip-skills suppresses that install but AGENTS.md/CLAUDE.md
    // are still written, the routing table must NOT name files that don't
    // exist — otherwise every agent load incurs 6 failed reads and the
    // routing instructions are worthless. Per-test tmpdir so the assertions
    // are not contaminated by a CLAUDE.md from an earlier test.
    const noStdDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-no-std-skills-'));
    const noStdStorage = path.join(noStdDir, '.gitnexus');
    await fs.mkdir(noStdStorage, { recursive: true });
    try {
      const stats = { nodes: 50, edges: 100, processes: 5 };
      await generateAIContextFiles(noStdDir, noStdStorage, 'TestProject', stats, undefined, {
        skipSkills: true,
      });

      const content = await fs.readFile(path.join(noStdDir, 'CLAUDE.md'), 'utf-8');
      expect(content).not.toContain('gitnexus-exploring/SKILL.md');
      expect(content).not.toContain('gitnexus-impact-analysis/SKILL.md');
      expect(content).not.toContain('gitnexus-debugging/SKILL.md');
      expect(content).not.toContain('gitnexus-refactoring/SKILL.md');
      expect(content).not.toContain('gitnexus-guide/SKILL.md');
      expect(content).not.toContain('gitnexus-cli/SKILL.md');
      // The load-bearing imperative sections must still ship — only the
      // routing rows are conditional.
      expect(content).toContain('## Always Do');
      expect(content).toContain('## Never Do');
      expect(content).toContain('gitnexus://repo/TestProject/context');
    } finally {
      await fs.rm(noStdDir, { recursive: true, force: true });
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

  // ──────────────────────────────────────────────────────────────────
  // Keep-marker edge cases (added to address PR #1508 review findings)
  // ──────────────────────────────────────────────────────────────────

  it('keep marker OUTSIDE the GitNexus section has no effect (#1508 review F5)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-keep-scope-'));
    try {
      const claudePath = path.join(dir, 'CLAUDE.md');
      // Keep marker appears in user prose BEFORE the GitNexus section.
      // The keep-path must NOT be triggered — full template replacement
      // is the correct behavior here, because the marker is not inside
      // the generated block.
      const fileWithOutOfBandMarker = `# My Project

A note about <!-- gitnexus:keep --> markers: they only apply inside the
GitNexus block below, not in prose like this.

<!-- gitnexus:start -->
Old verbose stub here.
<!-- gitnexus:end -->
`;
      await fs.writeFile(claudePath, fileWithOutOfBandMarker, 'utf-8');

      const stats = { nodes: 50, edges: 100, processes: 5 };
      await generateAIContextFiles(dir, path.join(dir, '.gitnexus'), 'TestProject', stats);

      const result = await fs.readFile(claudePath, 'utf-8');
      // Section MUST have been fully replaced — keep marker outside section ignored
      expect(result).toContain('## Always Do');
      expect(result).not.toContain('Old verbose stub here.');
      // User's prose with the marker reference is preserved untouched
      expect(result).toContain('A note about <!-- gitnexus:keep --> markers');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('AGENTS.md keep path preserves custom layout (#1508 review F5)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-keep-agents-'));
    try {
      const agentsPath = path.join(dir, 'AGENTS.md');
      const customAgents = `# AGENTS instructions

Project-specific agent guidance.

<!-- gitnexus:start -->
<!-- gitnexus:keep -->
# GitNexus context for AGENTS

Indexed as **AgentsTest** (10 symbols, 20 relationships, 1 execution flows).

Use 'query' for finding flows, 'context' for symbol details.
<!-- gitnexus:end -->
`;
      await fs.writeFile(agentsPath, customAgents, 'utf-8');

      const stats = { nodes: 777, edges: 888, processes: 9 };
      await generateAIContextFiles(dir, path.join(dir, '.gitnexus'), 'AgentsTest', stats);

      const result = await fs.readFile(agentsPath, 'utf-8');
      // Stats updated
      expect(result).toContain('777 symbols');
      expect(result).toContain('888 relationships');
      expect(result).toContain('9 execution flows');
      // Custom layout preserved
      expect(result).toContain('# GitNexus context for AGENTS');
      expect(result).toContain("Use 'query' for finding flows");
      // Verbose template NOT injected
      expect(result).not.toContain('## Always Do');
      // Non-GitNexus content preserved
      expect(result).toContain('# AGENTS instructions');
      expect(result).toContain('Project-specific agent guidance.');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('idempotent: second run with keep marker produces byte-identical output (#1508 review F5)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-keep-idem-'));
    try {
      const claudePath = path.join(dir, 'CLAUDE.md');
      const seed = `# Project

<!-- gitnexus:start -->
<!-- gitnexus:keep -->
Indexed as **Idem** (1 symbols, 2 relationships, 3 execution flows). Custom.
<!-- gitnexus:end -->
`;
      await fs.writeFile(claudePath, seed, 'utf-8');

      const stats = { nodes: 99, edges: 100, processes: 7 };
      await generateAIContextFiles(dir, path.join(dir, '.gitnexus'), 'Idem', stats);
      const afterFirst = await fs.readFile(claudePath, 'utf-8');

      await generateAIContextFiles(dir, path.join(dir, '.gitnexus'), 'Idem', stats);
      const afterSecond = await fs.readFile(claudePath, 'utf-8');

      expect(afterSecond).toBe(afterFirst);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('CRLF file with keep marker: stats line updates without corrupting content (#1508 review F5)', async () => {
    // upsertGitNexusSection writes with .trim() + '\n', so the saved file uses LF
    // line endings throughout — CRLF in the seed input is not preserved.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-keep-crlf-'));
    try {
      const claudePath = path.join(dir, 'CLAUDE.md');
      const crlfContent =
        '# Project\r\n' +
        '\r\n' +
        '<!-- gitnexus:start -->\r\n' +
        '<!-- gitnexus:keep -->\r\n' +
        'Indexed as **CRLFTest** (5 symbols, 6 relationships, 7 execution flows). Custom CRLF.\r\n' +
        '<!-- gitnexus:end -->\r\n';
      await fs.writeFile(claudePath, crlfContent, 'utf-8');

      const stats = { nodes: 50, edges: 60, processes: 7 };
      await generateAIContextFiles(dir, path.join(dir, '.gitnexus'), 'CRLFTest', stats);

      const result = await fs.readFile(claudePath, 'utf-8');
      // Stats updated correctly
      expect(result).toContain('50 symbols');
      expect(result).toContain('60 relationships');
      // Custom prose preserved
      expect(result).toContain('Custom CRLF');
      // No verbose template injected
      expect(result).not.toContain('## Always Do');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('noStats + keep marker: stats line update is NOT corrupted by Always-Do tuple text (#1508 review F3)', async () => {
    // Regression guard: with the old fallback regex `\(([^)]+)\)`, when
    // noStats=true suppressed the canonical stats line from generated
    // content, the fallback matched the FIRST parenthesized text in the
    // template, which was `({target: "symbolName", direction: "upstream"})`
    // from the Always Do bullet — silently writing that as the stats line.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-keep-nostats-'));
    try {
      const claudePath = path.join(dir, 'CLAUDE.md');
      const seed = `<!-- gitnexus:start -->
<!-- gitnexus:keep -->
Indexed as **NoStatsTest** (1 symbols, 1 relationships, 1 execution flows). Custom.
<!-- gitnexus:end -->
`;
      await fs.writeFile(claudePath, seed, 'utf-8');

      const stats = { nodes: 42, edges: 84, processes: 3 };
      await generateAIContextFiles(
        dir,
        path.join(dir, '.gitnexus'),
        'NoStatsTest',
        stats,
        undefined,
        { noStats: true },
      );

      const result = await fs.readFile(claudePath, 'utf-8');
      // Stats line MUST NOT have been corrupted with the Always-Do tuple text
      expect(result).not.toMatch(/\(\{target:/);
      expect(result).not.toMatch(/direction:\s*"upstream"/);
      // Stats line should reflect a sensible numeric update (passed stats)
      expect(result).toContain('42 symbols');
      // Custom prose still preserved
      expect(result).toContain('Custom.');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 'preserved' (not 'updated') when keep marker is present but no stats line matches (#1508 review F1)", async () => {
    // Regression guard for the misleading-return-value bug: previously the
    // function returned 'updated' without writing when the keep-section had
    // no recognizable stats line, causing CLI output to claim files were
    // updated when they were not.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-keep-noline-'));
    try {
      const claudePath = path.join(dir, 'CLAUDE.md');
      // Custom keep-section with NO "Indexed as ..." or "indexed by GitNexus as ..." line
      const seed = `# Project

<!-- gitnexus:start -->
<!-- gitnexus:keep -->
# GitNexus block (custom, no stats line)

This block intentionally omits the standard stats line.
<!-- gitnexus:end -->
`;
      await fs.writeFile(claudePath, seed, 'utf-8');

      const stats = { nodes: 100, edges: 200, processes: 10 };
      const result = await generateAIContextFiles(
        dir,
        path.join(dir, '.gitnexus'),
        'NoLineTest',
        stats,
      );

      // The result manifest should reflect 'preserved', not 'updated'
      expect(result.files).toContain('CLAUDE.md (preserved)');
      // File on disk is unchanged
      const onDisk = await fs.readFile(claudePath, 'utf-8');
      expect(onDisk).toBe(seed);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('project name with markdown-sensitive punctuation lands intact in stats line (#1508 review F5)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-keep-punct-'));
    try {
      const claudePath = path.join(dir, 'CLAUDE.md');
      const seed = `<!-- gitnexus:start -->
<!-- gitnexus:keep -->
Indexed as **placeholder** (1 symbols, 1 relationships, 1 execution flows). Custom.
<!-- gitnexus:end -->
`;
      await fs.writeFile(claudePath, seed, 'utf-8');

      // Name with hyphens, dot, and slash — exactly what dp-web4/some-repo
      // style names look like
      const trickyName = 'dp-web4/some-repo.v2';
      const stats = { nodes: 5, edges: 10, processes: 1 };
      await generateAIContextFiles(dir, path.join(dir, '.gitnexus'), trickyName, stats);

      const result = await fs.readFile(claudePath, 'utf-8');
      // The full name appears in the bold of the stats line, intact
      expect(result).toContain(`Indexed as **${trickyName}** (5 symbols`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
