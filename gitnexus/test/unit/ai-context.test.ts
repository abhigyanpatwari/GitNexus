import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  generateAIContextFiles,
  generateGitNexusContent,
  refreshBaseRefLine,
  markdownSafeBranch,
} from '../../src/cli/ai-context.js';

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

  it('emits the project-local runner command and drops .gitnexus/run.cjs regardless of mode (#1945)', async () => {
    const subDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-analyze-cmd-test-'));
    const subStorage = path.join(subDir, '.gitnexus');
    await fs.mkdir(subStorage, { recursive: true });
    const prior = process.env.GITNEXUS_INVOCATION;
    try {
      // Force a mode whose machine-resolved command (`gitnexus analyze`) differs
      // from the emitted string, so this fails loudly if generation ever goes
      // back to resolving the command per-machine instead of pointing at the
      // fixed, CLI-neutral project-local runner.
      process.env.GITNEXUS_INVOCATION = 'gitnexus';
      const stats = { nodes: 50, edges: 100, processes: 5 };
      await generateAIContextFiles(subDir, subStorage, 'CmdProject', stats);

      // The runner is copied next to the index so the emitted command resolves.
      const runner = await fs.readFile(path.join(subStorage, 'run.cjs'), 'utf-8');
      expect(runner).toContain('buildRunnerArgv'); // it's the real resolver copy

      for (const f of ['CLAUDE.md', 'AGENTS.md']) {
        const content = await fs.readFile(path.join(subDir, f), 'utf-8');
        // Primary command is the fixed project-local runner, not machine-resolved.
        expect(content).toContain('`node .gitnexus/run.cjs analyze`');
        expect(content).not.toContain('run `gitnexus analyze`'); // no machine-resolved leak
        // Bootstrap path (for a not-yet-analyzed checkout) + npm-11 escape hatch.
        expect(content).toContain('npx gitnexus analyze');
        expect(content).toContain('1939');
      }
    } finally {
      if (prior === undefined) delete process.env.GITNEXUS_INVOCATION;
      else process.env.GITNEXUS_INVOCATION = prior;
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it('emits Cross-Repo Groups commands through the project-local runner (#1945)', () => {
    // Exercise the groupNames>0 branch directly — the no-group path cannot
    // catch a group-command regression because the block is not emitted.
    const content = generateGitNexusContent(
      'TestProject',
      { nodes: 50, edges: 100, processes: 5 },
      { groupNames: ['TeamGroup'] },
    );
    expect(content).toContain('## Cross-Repo Groups');
    expect(content).toContain('node .gitnexus/run.cjs group list');
    expect(content).toContain('node .gitnexus/run.cjs group sync');
    expect(content).toContain('node .gitnexus/run.cjs group impact');
    // Group commands must not hardcode a package manager.
    expect(content).not.toMatch(/dlx gitnexus@latest group/);
    expect(content).not.toMatch(/npx gitnexus group/);
  });

  it('gates the pdg_query line on hasPdg (#2086 M6 — no existing taint gate to mirror)', () => {
    const stats = { nodes: 50, edges: 100, processes: 5 };
    // hasPdg=true → the pdg_query line is present.
    const withPdg = generateGitNexusContent('PdgProject', stats, { hasPdg: true });
    expect(withPdg).toContain('pdg_query');
    expect(withPdg).toContain('under what condition does X run');
    expect(withPdg).toContain('line: <N>');
    expect(withPdg).toContain('affectedStatements');
    expect(withPdg).toContain('byDepth');
    // hasPdg omitted (default false) → no pdg_query line; a non-pdg index must
    // not advertise a tool that only returns a "no PDG layer" note.
    const withoutPdg = generateGitNexusContent('PlainProject', stats);
    expect(withoutPdg).not.toContain('pdg_query');
    // the unconditional explain line stays regardless of the pdg flag.
    expect(withoutPdg).toContain('explain(');
  });

  it('degrades gracefully when the runner copy fails (#1945)', async () => {
    // A read-only/full-disk storage dir must not abort generation. The copy is
    // best-effort + logged; the generated docs still carry the inline bootstrap
    // (`npx gitnexus analyze`) so a reader hitting the absent runner has a path.
    const subDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-copyfail-'));
    const subStorage = path.join(subDir, '.gitnexus');
    await fs.mkdir(subStorage, { recursive: true });
    const spy = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(new Error('EACCES: read-only'));
    try {
      const stats = { nodes: 50, edges: 100, processes: 5 };
      // Must not throw despite the copy failure.
      await generateAIContextFiles(subDir, subStorage, 'CopyFail', stats);
      const content = await fs.readFile(path.join(subDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('npx gitnexus analyze'); // bootstrap survives
      // The runner was not written, so the file is absent.
      await expect(fs.access(path.join(subStorage, 'run.cjs'))).rejects.toThrow();
    } finally {
      spy.mockRestore();
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

    expect(content).toContain('Index stale? Run `node .gitnexus/run.cjs analyze`');
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
    // 52% reduction. The ceiling is a soft cap that still leaves headroom for
    // legitimate future additions but will fail loudly if the trim is
    // reverted or someone pads the block back out toward the original size.
    //
    // Raised 2700 → 2900 for #243: the regression-compare example (one
    // load-bearing per-repo `base_ref` line on the detect_changes bullet) is a
    // legitimate addition, not a revert of the trim — the block stays roughly
    // half the original size.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    const block = content.slice(
      content.indexOf('<!-- gitnexus:start -->'),
      content.indexOf('<!-- gitnexus:end -->'),
    );
    expect(block.length).toBeLessThan(2900);
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

  it('installs standard skills as direct children of .claude/skills (#2433)', async () => {
    const stats = { nodes: 10 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const standardSkills = [
      'gitnexus-exploring',
      'gitnexus-debugging',
      'gitnexus-impact-analysis',
      'gitnexus-refactoring',
      'gitnexus-guide',
      'gitnexus-cli',
    ];
    for (const skill of standardSkills) {
      await expect(
        fs.access(path.join(tmpDir, '.claude', 'skills', skill, 'SKILL.md')),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(path.join(tmpDir, '.claude', 'skills', 'gitnexus', skill, 'SKILL.md')),
      ).rejects.toThrow();
    }

    const claudeContent = generateGitNexusContent('TestProject', stats);
    expect(claudeContent).toContain('.claude/skills/gitnexus-exploring/SKILL.md');
    expect(claudeContent).not.toContain('.claude/skills/gitnexus/gitnexus-exploring/SKILL.md');
  });

  it('migrates known nested standard skills without deleting user-owned siblings (#2433)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-skill-migrate-'));
    const storage = path.join(dir, '.gitnexus');
    const legacyKnown = path.join(dir, '.claude', 'skills', 'gitnexus', 'gitnexus-exploring');
    const legacyUnknown = path.join(dir, '.claude', 'skills', 'gitnexus', 'custom-team-skill');
    const unrelated = path.join(dir, '.claude', 'skills', 'auth');
    await fs.mkdir(legacyKnown, { recursive: true });
    await fs.mkdir(legacyUnknown, { recursive: true });
    await fs.mkdir(unrelated, { recursive: true });
    await fs.writeFile(path.join(legacyKnown, 'SKILL.md'), 'legacy', 'utf-8');
    await fs.writeFile(path.join(legacyUnknown, 'SKILL.md'), 'custom nested', 'utf-8');
    await fs.writeFile(path.join(unrelated, 'SKILL.md'), 'custom direct', 'utf-8');

    try {
      await generateAIContextFiles(dir, storage, 'TestProject', { nodes: 10 });

      await expect(
        fs.access(path.join(dir, '.claude', 'skills', 'gitnexus-exploring', 'SKILL.md')),
      ).resolves.toBeUndefined();
      await expect(fs.access(legacyKnown)).rejects.toThrow();
      await expect(fs.readFile(path.join(legacyUnknown, 'SKILL.md'), 'utf-8')).resolves.toBe(
        'custom nested',
      );
      await expect(fs.readFile(path.join(unrelated, 'SKILL.md'), 'utf-8')).resolves.toBe(
        'custom direct',
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not create standard skill directories when skipSkills is true (#742)', async () => {
    // Regression guard for #742. The --skip-skills flag must prevent
    // installSkills() from writing the 6 standard skill dirs into the
    // analyzed repo. Per-test tmpdir so we start from a known-clean
    // slate — the shared tmpDir from beforeAll may already contain
    // direct .claude/skills/gitnexus-* directories from an earlier test.
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

      expect(result.files).toContain('.claude/skills/gitnexus-*/ (skipped via --skip-skills)');
      await expect(
        fs.access(path.join(skipDir, '.claude', 'skills', 'gitnexus-exploring')),
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
      expect(result.files).toContain('.claude/skills/gitnexus-*/ (skipped via --skip-skills)');

      await expect(fs.access(path.join(idxDir, 'AGENTS.md'))).rejects.toThrow();
      await expect(fs.access(path.join(idxDir, 'CLAUDE.md'))).rejects.toThrow();
      await expect(
        fs.access(path.join(idxDir, '.claude', 'skills', 'gitnexus-exploring')),
      ).rejects.toThrow();
    } finally {
      await fs.rm(idxDir, { recursive: true, force: true });
    }
  });

  it('omits standard skill references from AGENTS.md/CLAUDE.md when skipSkills is true (#742)', async () => {
    // The skills routing table in AGENTS.md/CLAUDE.md points agents at
    // .claude/skills/gitnexus-*/SKILL.md files installed by installSkills().
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

  it('keeps direct community skill paths when standard skills are skipped (#2433)', () => {
    const content = generateGitNexusContent(
      'TestProject',
      { nodes: 50, edges: 100, processes: 5 },
      {
        skipSkills: true,
        generatedSkills: [
          {
            name: 'gitnexus-area-auth',
            label: 'Auth',
            symbolCount: 40,
            fileCount: 5,
          },
        ],
      },
    );

    expect(content).toContain('.claude/skills/gitnexus-area-auth/SKILL.md');
    expect(content).not.toContain('.claude/skills/gitnexus-exploring/SKILL.md');
    expect(content).not.toContain('.claude/skills/generated/');
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

  it('noStats + keep marker: stats line drops the volatile counts (#1706)', async () => {
    // #1706: --no-stats must win in the keep-marker path too. A lean block
    // committed to git would otherwise churn the parenthetical counts on
    // every analyze, producing no-value merge conflicts between branches.
    // The parenthetical is stripped; the project name still refreshes.
    //
    // Also a regression guard (#1508 review F3): the rewritten stats line
    // MUST NOT pick up the `({target: "symbolName", direction: "upstream"})`
    // tuple from the Always Do bullet.
    //
    // Asserted for BOTH AGENTS.md and CLAUDE.md: generateAIContextFiles
    // updates them through separate upsertGitNexusSection call sites, so the
    // parity check guards against a future asymmetry between the two.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-keep-nostats-'));
    try {
      const seed = `<!-- gitnexus:start -->
<!-- gitnexus:keep -->
Indexed as **NoStatsTest** (1 symbols, 1 relationships, 1 execution flows). Custom.
<!-- gitnexus:end -->
`;
      await fs.writeFile(path.join(dir, 'CLAUDE.md'), seed, 'utf-8');
      await fs.writeFile(path.join(dir, 'AGENTS.md'), seed, 'utf-8');

      const stats = { nodes: 42, edges: 84, processes: 3 };
      await generateAIContextFiles(
        dir,
        path.join(dir, '.gitnexus'),
        'NoStatsTest',
        stats,
        undefined,
        {
          noStats: true,
        },
      );

      for (const f of ['CLAUDE.md', 'AGENTS.md']) {
        const result = await fs.readFile(path.join(dir, f), 'utf-8');
        // Stats line MUST NOT have been corrupted with the Always-Do tuple text
        expect(result, f).not.toMatch(/\(\{target:/);
        expect(result, f).not.toMatch(/direction:\s*"upstream"/);
        // The volatile counts MUST be gone — no parenthetical, no leaked numbers.
        expect(result, f).not.toContain('42 symbols');
        expect(result, f).not.toMatch(/\(\d+\s+symbols,/);
        // The count-free stats line is still present and the name refreshed.
        expect(result, f).toContain('Indexed as **NoStatsTest**');
        // Custom prose still preserved
        expect(result, f).toContain('Custom.');
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('noStats + keep marker: project name still refreshes when counts are stripped (#1706)', async () => {
    // Stripping the parenthetical must not freeze the whole line: a repo
    // rename should still propagate into the keep-section stats line, even
    // when the existing line has no parenthetical to match against.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-keep-nostats-rename-'));
    try {
      const claudePath = path.join(dir, 'CLAUDE.md');
      // Seed already in the count-free shape a prior --no-stats run produces.
      const seed = `<!-- gitnexus:start -->
<!-- gitnexus:keep -->
Indexed as **OldName**. Custom.
<!-- gitnexus:end -->
`;
      await fs.writeFile(claudePath, seed, 'utf-8');

      const stats = { nodes: 7, edges: 8, processes: 9 };
      await generateAIContextFiles(dir, path.join(dir, '.gitnexus'), 'NewName', stats, undefined, {
        noStats: true,
      });

      const result = await fs.readFile(claudePath, 'utf-8');
      expect(result).toContain('Indexed as **NewName**');
      expect(result).not.toContain('OldName');
      expect(result).not.toMatch(/\(\d+\s+symbols,/);
      expect(result).toContain('Custom.');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('noStats + keep marker: counts return when --no-stats is dropped after a count-free run (#1706)', async () => {
    // --no-stats must not be sticky: once a prior run has left the
    // keep-section line count-free, a later run WITHOUT --no-stats must
    // restore the parenthetical. The optional parenthetical in statsPattern
    // is what keeps the count-free line re-matchable.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-keep-counts-return-'));
    try {
      const claudePath = path.join(dir, 'CLAUDE.md');
      // Seed already in the count-free shape a prior --no-stats run produces.
      const seed = `<!-- gitnexus:start -->
<!-- gitnexus:keep -->
Indexed as **FreezeTest**. Custom.
<!-- gitnexus:end -->
`;
      await fs.writeFile(claudePath, seed, 'utf-8');

      const stats = { nodes: 11, edges: 22, processes: 3 };
      // No noStats option — the counts must come back.
      await generateAIContextFiles(dir, path.join(dir, '.gitnexus'), 'FreezeTest', stats);

      const result = await fs.readFile(claudePath, 'utf-8');
      expect(result).toContain(
        'Indexed as **FreezeTest** (11 symbols, 22 relationships, 3 execution flows)',
      );
      // Suffix prose after the stats line is preserved.
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

  // ──────────────────────────────────────────────────────────────────
  // Configurable default branch in the regression example (#243)
  // ──────────────────────────────────────────────────────────────────

  it('generated regression-compare example uses the configured default branch (#243)', () => {
    const stats = { nodes: 50, edges: 100, processes: 5 };
    const develop = generateGitNexusContent('P', stats, { defaultBranch: 'develop' });
    expect(develop).toContain('base_ref: "develop"');
    expect(develop).not.toContain('base_ref: "main"');
  });

  it('defaults the regression-compare example to "main" when no branch is configured (#243)', () => {
    const content = generateGitNexusContent('P', { nodes: 50, edges: 100, processes: 5 });
    expect(content).toContain('base_ref: "main"');
  });

  it('references MCP tools by their registered (unprefixed) names (#2059)', () => {
    const content = generateGitNexusContent('P', { nodes: 50, edges: 100, processes: 5 });
    // The server registers tools without a `gitnexus_` prefix (see mcp/tools.ts);
    // generated instructions must use the exact callable names or agents call a
    // tool that does not exist.
    expect(content).not.toMatch(/gitnexus_(impact|query|context|detect_changes|rename|cypher)/);
    expect(content).toContain('impact({target: "symbolName", direction: "upstream"})');
    expect(content).toContain('detect_changes()');
    // #2175: the generated guidance must advertise the renamed param, never the
    // legacy "query" key (Claude Code drops a tool arg named exactly "query").
    expect(content).toContain('query({search_query: "concept"})');
    expect(content).not.toContain('query({query:');
    expect(content).toContain('context({name: "symbolName"})');
  });

  it('JSON-escapes a markdown/quote-bearing branch so it cannot break the code span (#243)', () => {
    // A branch name with a double-quote must be JSON-escaped, not concatenated
    // raw, so it stays inside the inline code span.
    const content = generateGitNexusContent('P', { nodes: 1 }, { defaultBranch: 'we"ird' });
    expect(content).toContain('base_ref: "we\\"ird"');
  });

  it('a backtick branch cannot break the generated Markdown code span (#1996 P1)', () => {
    // The branch is embedded inside a backtick inline-code span; a stray
    // backtick would close it early. markdownSafeBranch strips it at the sink.
    const content = generateGitNexusContent('P', { nodes: 1 }, { defaultBranch: 'main`evil' });
    const line = content.split('\n').find((l) => l.includes('base_ref'))!;
    // Even backtick count ⇒ every span is balanced (the regression line opens
    // and closes exactly one).
    expect((line.match(/`/g) || []).length % 2).toBe(0);
    expect(line).not.toContain('main`evil');
    expect(markdownSafeBranch('a`b`c')).toBe('abc');
  });

  it('refreshBaseRefLine updates base_ref in place, preserving the rest of the block (#1996 P2)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-baseref-'));
    try {
      // Seed a realistic block: a configured base_ref "main" plus a community
      // skill row that a prior --skills run would have written.
      const seed = `# Project

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

- run \`detect_changes({scope: "compare", base_ref: "main"})\`.

| Task | Read this skill file |
|------|---------------------|
| Work in the Auth area (40 symbols) | \`.claude/skills/gitnexus-area-auth/SKILL.md\` |
<!-- gitnexus:end -->
`;
      for (const f of ['AGENTS.md', 'CLAUDE.md']) {
        await fs.writeFile(path.join(dir, f), seed, 'utf-8');
      }

      const res = await refreshBaseRefLine(dir, 'develop');
      expect(res.files.sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);

      for (const f of ['AGENTS.md', 'CLAUDE.md']) {
        const after = await fs.readFile(path.join(dir, f), 'utf-8');
        expect(after).toContain('base_ref: "develop"');
        expect(after).not.toContain('base_ref: "main"');
        // The community-skill row (and everything else) is preserved.
        expect(after).toContain('.claude/skills/gitnexus-area-auth/SKILL.md');
      }

      // Idempotent: a second run with the same branch writes nothing.
      const again = await refreshBaseRefLine(dir, 'develop');
      expect(again.files).toEqual([]);

      // skipAgentsMd short-circuits entirely.
      const skipped = await refreshBaseRefLine(dir, 'master', { skipAgentsMd: true });
      expect(skipped.files).toEqual([]);
      expect(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf-8')).toContain(
        'base_ref: "develop"',
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refreshBaseRefLine is a no-op when there is no base_ref line or no file (#1996 P2)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-baseref-noop-'));
    try {
      // No AGENTS.md/CLAUDE.md at all → no files updated, no throw.
      expect((await refreshBaseRefLine(dir, 'develop')).files).toEqual([]);
      // A keep-style block with no base_ref line is left untouched.
      const seed = `<!-- gitnexus:start -->
<!-- gitnexus:keep -->
Indexed as **P**. Custom.
<!-- gitnexus:end -->
`;
      await fs.writeFile(path.join(dir, 'CLAUDE.md'), seed, 'utf-8');
      expect((await refreshBaseRefLine(dir, 'develop')).files).toEqual([]);
      expect(await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe(seed);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('threads defaultBranch through generateAIContextFiles into AGENTS.md and CLAUDE.md (#243)', async () => {
    const subDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-default-branch-'));
    const subStorage = path.join(subDir, '.gitnexus');
    await fs.mkdir(subStorage, { recursive: true });
    try {
      const stats = { nodes: 50, edges: 100, processes: 5 };
      await generateAIContextFiles(subDir, subStorage, 'P', stats, undefined, {
        defaultBranch: 'release/1.0',
      });
      for (const f of ['CLAUDE.md', 'AGENTS.md']) {
        const content = await fs.readFile(path.join(subDir, f), 'utf-8');
        expect(content).toContain('base_ref: "release/1.0"');
        expect(content).not.toContain('base_ref: "main"');
      }
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });
});
