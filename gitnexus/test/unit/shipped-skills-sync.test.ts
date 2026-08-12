import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RENAMED_SKILL_DIRS } from '../../src/cli/setup.js';
import { STANDARD_SKILL_CATALOG, type StandardSkillName } from '../../src/cli/standard-skills.js';

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
const STANDARD_SKILL_NAMES = STANDARD_SKILL_CATALOG.map((skill) => skill.name);
const SPECIALIZED_NESTED_SKILLS = ['gitnexus-pdg-query', 'gitnexus-taint-analysis'] as const;

function listFilesRecursive(dir: string, base: string = dir): string[] {
  // readdirSync follows a symlinked directory, so a mirror dir aliased to the
  // canonical tree would pass the byte-compare. Reject a symlinked root.
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error(`shipped skill path must not be a symlink: ${dir}`);
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // A symlinked file is typed as a non-directory and readFileSync would follow
    // it to the canonical bytes — a silent pass. Only real, byte-identical files
    // (and real directories) may make up a shipped mirror.
    if (entry.isSymbolicLink()) {
      throw new Error(`shipped skill entry must be a regular file, not a symlink: ${full}`);
    }
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

function standardSkillCopies(name: StandardSkillName): string[] {
  const entry = STANDARD_SKILL_CATALOG.find((skill) => skill.name === name);
  if (!entry) throw new Error(`Unknown standard skill: ${name}`);

  const copies: string[] = [];
  if (entry.distributions.project) {
    copies.push(path.join(REPO_ROOT, '.claude', 'skills', name, 'SKILL.md'));
  }
  if (entry.distributions.npm) {
    copies.push(path.join(REPO_ROOT, 'gitnexus', 'skills', `${name}.md`));
  }
  if (entry.distributions.claudePlugin) {
    copies.push(path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills', name, 'SKILL.md'));
  }
  if (entry.distributions.cursor) {
    copies.push(path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'skills', name, 'SKILL.md'));
  }
  return copies;
}

function discoverStandardSkillNames(): string[] {
  const bundledSkillsDir = path.join(REPO_ROOT, 'gitnexus', 'skills');
  return fs
    .readdirSync(bundledSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -'.md'.length))
    .filter(
      (name) =>
        fs.existsSync(path.join(REPO_ROOT, '.claude', 'skills', name, 'SKILL.md')) &&
        fs.existsSync(path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills', name, 'SKILL.md')),
    )
    .sort();
}

describe('standard skill catalog coverage', () => {
  const discovered = discoverStandardSkillNames();

  it('exactly matches the independently discovered standard skills', () => {
    expect([...STANDARD_SKILL_NAMES].sort()).toEqual(discovered);
  });

  it('exactly matches the independently discovered Cursor subset', () => {
    const discoveredCursor = discovered.filter((name) =>
      fs.existsSync(
        path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'skills', name, 'SKILL.md'),
      ),
    );
    const catalogCursor = STANDARD_SKILL_CATALOG.filter((skill) => skill.distributions.cursor)
      .map((skill) => skill.name)
      .sort();
    expect(catalogCursor).toEqual(discoveredCursor);
  });
});

describe.each(STANDARD_SKILL_NAMES)('standard skill distribution for %s', (name) => {
  it('contains every applicable canonical and shipped copy', () => {
    expect(standardSkillCopies(name).map((file) => fs.existsSync(file))).toEqual(
      standardSkillCopies(name).map(() => true),
    );
  });
});

describe('intended standard-skill improvements stay in every applicable copy', () => {
  it('documents the PDG analyze flag in every CLI copy', () => {
    for (const file of standardSkillCopies('gitnexus-cli')) {
      expect(fs.readFileSync(file, 'utf-8')).toContain('`--pdg`');
    }
  });

  // These copies are NOT byte-compared (only the engineering FAMILY above is),
  // so a runner added to resolve-analyze-cmd.cjs can silently miss them. The
  // audience that most needs bunx documented — a bun-only machine with no npm,
  // npx or pnpm — is exactly the one an npx/pnpm-only bootstrap line strands.
  it('documents the bunx runner and bootstrap in every CLI copy', () => {
    for (const file of standardSkillCopies('gitnexus-cli')) {
      const content = fs.readFileSync(file, 'utf-8');
      expect(content).toContain('else `bunx`');
      expect(content).toContain('bunx gitnexus@latest analyze');
    }
  });

  it('documents every Wiki Profile contract in every CLI copy', () => {
    const required = [
      '`--profile <id>`',
      '`default`',
      '`arc42`',
      '`engineering-wiki`',
      '`ieee-1016-sdd`',
      '`iso-42010-ad`',
      '--profile ieee-1016-sdd --lang chinese',
      '--profile engineering-wiki --lang chinese',
      'stable English values',
      'falls back to English',
      '.state/current.json',
      'Profile coverage checks do not establish standards conformance.',
    ];
    for (const file of standardSkillCopies('gitnexus-cli')) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const fragment of required) expect(content).toContain(fragment);
    }
  });

  it('documents CLI fallbacks in every impact-analysis copy', () => {
    const required = [
      'node .gitnexus/run.cjs impact <symbol> --direction upstream --repo .',
      'node .gitnexus/run.cjs detect-changes --scope all --repo .',
      'replace `node .gitnexus/run.cjs` with `npx gitnexus`',
      'detect_changes({scope: "all"})',
    ];
    for (const file of standardSkillCopies('gitnexus-impact-analysis')) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const fragment of required) expect(content).toContain(fragment);
    }
  });

  // The risk scale's own escape hatch. `UNKNOWN` means the walk could not
  // answer, and an agent that reads it as a low rung proceeds on a zero — the
  // one reading the verdict exists to prevent.
  //
  // This assertion exists because its absence let real drift ship: the canonical
  // `.claude/` copy lost the UNKNOWN block while the plugin mirror kept it, and
  // this suite passed 54/54 with the two copies contradicting each other. The
  // byte-identical check above covers only the plan/work/review/lfg family, and
  // the fragment lists are the only guard the standard skills get — so a fragment
  // that is not listed is a fragment nothing protects.
  it('keeps the UNKNOWN-risk guidance in every impact-analysis copy', () => {
    const required = [
      '| **Zero callers found**         | **UNKNOWN** |',
      '`UNKNOWN` is not a low rung on this scale',
      'Confirm with a text search before',
    ];
    const copies = standardSkillCopies('gitnexus-impact-analysis');
    // Guard the guard: an empty copy list would make every loop below vacuous.
    expect(copies.length).toBeGreaterThan(1);
    for (const file of copies) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const fragment of required) expect(content).toContain(fragment);
    }
  });

  // Same shape as the UNKNOWN guard above, for the other half of the verdict:
  // `detect_changes` can come back SHORT — `partial` when a batched graph query
  // failed, `truncated` when the changed-symbol listing hit its cap — and both
  // read as a clean gate if the agent only looks at the count (#2915). The
  // wording differs per copy (the Cursor mirror compresses it to one blockquote
  // line), so the fragments here are the parts every copy shares.
  it('keeps the partial/truncated degradation guidance in every impact-analysis copy', () => {
    const required = [
      '`partial: true` (a graph query failed) or `truncated: true` (the changed-symbol',
      'listing was capped)',
      'a zero there means unseen, not unaffected.',
      'tick the pre-commit check.',
    ];
    const copies = standardSkillCopies('gitnexus-impact-analysis');
    // Guard the guard: an empty copy list would make the loop below vacuous.
    expect(copies.length).toBeGreaterThan(1);
    for (const file of copies) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const fragment of required) expect(content).toContain(fragment);
    }
  });

  // The refactoring copies carry the same warning for the verification step a
  // refactor ends on: there, a short list reads as "only the expected files
  // changed" rather than as a low risk score.
  it('keeps the partial/truncated degradation guidance in every refactoring copy', () => {
    const required = [
      '`partial: true` (a graph query failed) or `truncated: true` (the changed-symbol',
      'listing was capped)',
      'is not proof that only the expected files changed.',
      'treat the refactor as verified.',
    ];
    const copies = standardSkillCopies('gitnexus-refactoring');
    expect(copies.length).toBeGreaterThan(1);
    for (const file of copies) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const fragment of required) expect(content).toContain(fragment);
    }
  });

  it('documents the current tools, schema, and cross-repo trace in every guide copy', () => {
    const required = [
      '`route_map`',
      '`shape_check`',
      '`api_impact`',
      '`tool_map`',
      '`group_list`',
      '`group_sync`',
      '`TAINT_PATH`',
      'Cross-repo (experimental)',
      'Read `gitnexus://repo/{name}/schema` before writing Cypher',
    ];
    for (const file of standardSkillCopies('gitnexus-guide')) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const fragment of required) expect(content).toContain(fragment);
    }
  });

  // #2899: the "Inline staleness signal" section was deleted from the
  // canonical `.claude/` copy by an unrelated commit while the plugin mirror
  // kept it — the same silent-deletion shape as the UNKNOWN-risk guard above,
  // just for a hand-authored section instead of the machine-managed block.
  // Scoped to canonical + plugin only: at the time of writing the npm mirror
  // (gitnexus/skills/gitnexus-guide.md) already lacks this section as
  // pre-existing, unrelated drift, so folding it into the loop above would
  // fail on that unrelated copy instead of guarding this regression.
  it('keeps the inline-staleness-signal section in the canonical and plugin guide copies', () => {
    for (const file of [
      path.join(REPO_ROOT, '.claude', 'skills', 'gitnexus-guide', 'SKILL.md'),
      path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills', 'gitnexus-guide', 'SKILL.md'),
    ]) {
      const content = fs.readFileSync(file, 'utf-8');
      expect(content).toContain('### Inline staleness signal');
      expect(content).toContain('commitsBehind');
    }
  });

  it("uses the rename API's text_search vocabulary in every refactoring copy", () => {
    for (const file of standardSkillCopies('gitnexus-refactoring')) {
      const content = fs.readFileSync(file, 'utf-8');
      expect(content).toContain('text_search');
      expect(content).not.toContain('ast_search');
    }
  });
});

/**
 * The body of the root AGENTS.md / CLAUDE.md machine-managed block
 * (`<!-- gitnexus:start -->` … `<!-- gitnexus:end -->`), which
 * generateGitNexusContent (src/cli/ai-context.ts) regenerates on every
 * `gitnexus analyze`. Shared by the policy guards below.
 */
function extractManagedBlock(file: string): string {
  const content = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
  // Markers must occupy their own line — CLAUDE.md's "GitNexus rules"
  // section links to AGENTS.md with an inline prose mention of both
  // marker strings ("See the `<!-- gitnexus:start --> ... `" etc.) that a
  // bare indexOf would mistake for the real block (mirrors
  // findSectionMarkerIndex in ai-context.ts, #1041).
  const match =
    /(?:^|\n)<!-- gitnexus:start -->\r?\n([\s\S]*?)\n<!-- gitnexus:end -->(?:\r?\n|$)/.exec(
      content,
    );
  expect(match, `${file} must contain an own-line gitnexus:start/end block`).not.toBeNull();
  return match![1];
}

// The `risk: UNKNOWN` Always-Do bullet and its Never-Do clause were hand-added
// INSIDE the machine-managed region instead of living in the template, so a
// real analyze run silently deleted them on regeneration — twice (#2856's
// 8f8261021, then #2899's 9e602aef0, which piggybacked an unrelated
// fetch-parsing fix and also regressed the index stats 248612/565510/918 ->
// 42853/135955/758, itself evidence the block had been rebuilt from a stale
// local index). ai-context.ts now generates both lines directly regardless of
// `hasPdg` (see ai-context.test.ts's hasPdg-independent UNKNOWN test), so a
// real analyze cannot drop them again. This guard is the second line of
// defense: it reads the committed docs themselves, so a hand-revert or a stale
// generator binary landing the same regression fails here even if the template
// is fine.
describe('root AGENTS.md / CLAUDE.md managed block keeps the risk: UNKNOWN policy (#2899)', () => {
  const REQUIRED_FRAGMENTS = [
    'MUST treat `risk: UNKNOWN` as unresolved, not as low.',
    'never read `UNKNOWN` as an all-clear',
  ];

  it.each(['AGENTS.md', 'CLAUDE.md'])('%s managed block documents the policy', (file) => {
    const block = extractManagedBlock(file);
    for (const fragment of REQUIRED_FRAGMENTS) expect(block).toContain(fragment);
  });

  it.each(['AGENTS.md', 'CLAUDE.md'])(
    "%s managed block's Always Do / Never Do bullet counts do not drop below the known floor",
    (file) => {
      const block = extractManagedBlock(file);
      const alwaysDoSection = block.slice(
        block.indexOf('## Always Do'),
        block.indexOf('## Never Do'),
      );
      const neverDoSection = block.slice(block.indexOf('## Never Do'));
      // 7 Always-Do bullets are unconditional; an 8th (pdg_query) only
      // appears when the index was built with --pdg, so the floor is 7, not 8.
      expect((alwaysDoSection.match(/^- /gm) || []).length).toBeGreaterThanOrEqual(7);
      // Never Do never varies with hasPdg — exactly 4 today, so 4 is the floor.
      expect((neverDoSection.match(/^- NEVER /gm) || []).length).toBeGreaterThanOrEqual(4);
    },
  );
});

// The same second-line-of-defense reading for the OTHER thing the block now
// says about the pre-commit gate: a `detect_changes` that came back `partial`
// (a batched graph query failed) or `truncated` (the changed-symbol listing hit
// its cap) has not cleared anything (#2915). It lives inside the machine-managed
// region, so it survives only as long as ai-context.ts keeps generating it —
// exactly the shape that was silently deleted twice above. Reading the
// committed docs catches a stale generator binary or a hand-revert too.
describe('root AGENTS.md / CLAUDE.md managed block keeps the degraded-detect_changes policy (#2915)', () => {
  const REQUIRED_FRAGMENTS = [
    // Deliberately short. The block is under a hard size cap (#856), so this
    // sentence gets re-trimmed whenever anything else in the block grows — it
    // already lost both parentheticals to pay for restoring the `detect-changes`
    // subcommand in the regression example. Pin the two claims that carry the
    // policy, not the prose around them.
    '`partial: true` or `truncated: true` is not a clean check',
    'a zero means unseen, not unaffected; re-run it',
  ];

  it.each(['AGENTS.md', 'CLAUDE.md'])('%s managed block documents the policy', (file) => {
    const block = extractManagedBlock(file);
    for (const fragment of REQUIRED_FRAGMENTS) expect(block).toContain(fragment);
  });
});

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

describe.each(STANDARD_SKILL_NAMES)('duplicate nested standard skill %s stays deleted', (name) => {
  it('has no files under .claude/skills/gitnexus/', () => {
    expect(filesUnder(path.join(REPO_ROOT, '.claude', 'skills', 'gitnexus', name))).toEqual([]);
  });
});

describe.each(SPECIALIZED_NESTED_SKILLS)(
  'specialized nested skill %s remains available',
  (name) => {
    it('retains its SKILL.md', () => {
      expect(
        fs.existsSync(path.join(REPO_ROOT, '.claude', 'skills', 'gitnexus', name, 'SKILL.md')),
      ).toBe(true);
    });
  },
);

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

describe('skill-sync workflow contract', () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'skill-sync.yml'),
    'utf-8',
  );
  const guardedPaths = [
    '.claude/skills/gitnexus-*/**',
    '.claude/skills/gitnexus/**',
    'gitnexus/skills/**',
    'gitnexus-claude-plugin/skills/**',
    'gitnexus-cursor-integration/skills/**',
    'gitnexus/test/unit/shipped-skills-sync.test.ts',
    'gitnexus/test/unit/skills-steering.test.ts',
    'gitnexus/test/unit/engineering-skills-contract.test.ts',
    'gitnexus/test/unit/evidence-provenance-helper.test.ts',
    '.github/workflows/skill-sync.yml',
  ];

  it.each(guardedPaths)('triggers on %s for both pull requests and main pushes', (guardedPath) => {
    expect(workflow.split(`- '${guardedPath}'`).length - 1).toBe(2);
  });

  it('runs parity, steering, engineering, and provenance contracts in one blocking job', () => {
    expect(workflow).toContain('npx vitest run');
    expect(workflow).toContain('test/unit/shipped-skills-sync.test.ts');
    expect(workflow).toContain('test/unit/skills-steering.test.ts');
    expect(workflow).toContain('test/unit/engineering-skills-contract.test.ts');
    expect(workflow).toContain('test/unit/evidence-provenance-helper.test.ts');
  });
});

describe.skipIf(process.platform === 'win32')(
  'drift guard rejects symlinked shipped entries',
  () => {
    it('rejects a mirror file symlinked to the canonical copy instead of passing byte-compare', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-drift-file-'));
      try {
        const canonical = path.join(tmp, 'canonical-SKILL.md');
        fs.writeFileSync(canonical, 'canonical content');
        const mirror = path.join(tmp, 'mirror');
        fs.mkdirSync(mirror);
        fs.symlinkSync(canonical, path.join(mirror, 'SKILL.md'));
        expect(() => snapshotDir(mirror)).toThrow(/symlink/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('rejects a mirror subdirectory that is a symlink', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-drift-dir-'));
      try {
        const realDir = path.join(tmp, 'real');
        fs.mkdirSync(realDir);
        fs.writeFileSync(path.join(realDir, 'SKILL.md'), 'x');
        const mirror = path.join(tmp, 'mirror');
        fs.mkdirSync(mirror);
        fs.symlinkSync(realDir, path.join(mirror, 'scripts'));
        expect(() => listFilesRecursive(mirror)).toThrow(/symlink/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('still accepts a mirror made only of real byte-identical files', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-drift-real-'));
      try {
        const mirror = path.join(tmp, 'mirror');
        fs.mkdirSync(path.join(mirror, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(mirror, 'SKILL.md'), 'real');
        fs.writeFileSync(path.join(mirror, 'scripts', 'helper.mjs'), 'real');
        expect(snapshotDir(mirror)).toEqual({
          'SKILL.md': 'real',
          'scripts/helper.mjs': 'real',
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  },
);
