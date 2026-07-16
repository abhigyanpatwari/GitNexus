/**
 * AI Context Generator
 *
 * Creates AGENTS.md and CLAUDE.md with full inline GitNexus context.
 * AGENTS.md is the standard read by Cursor, Windsurf, OpenCode, Codex, Cline, CodeBuddy, Qoder, etc.
 * CLAUDE.md is for Claude Code which only reads that file.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { type GeneratedSkillInfo } from './skill-gen.js';
import { logger } from '../core/logger.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RepoStats {
  files?: number;
  nodes?: number;
  edges?: number;
  communities?: number;
  clusters?: number; // Aggregated cluster count (what tools show)
  processes?: number;
}

export interface AIContextOptions {
  skipAgentsMd?: boolean;
  noStats?: boolean;
  skipSkills?: boolean;
  /**
   * Default branch used by the generated regression-compare example (#243).
   * Resolved by the CLI (CLI flag > `.gitnexusrc` > auto-detect > "main"); a
   * plain caller that omits it gets "main", preserving prior behavior.
   */
  defaultBranch?: string;
  /**
   * Whether the index was built with `--pdg` (#2086 M6). Gates the `pdg_query`
   * line in the generated block — without the PDG layer the tool only returns a
   * "no PDG layer" note, so advertising it on a non-`--pdg` index is noise.
   */
  hasPdg?: boolean;
}

const GITNEXUS_START_MARKER = '<!-- gitnexus:start -->';
const GITNEXUS_END_MARKER = '<!-- gitnexus:end -->';

/**
 * Find the index of a section marker that occupies its own line.
 * Unlike `indexOf`, this rejects inline prose references like
 * `` See the `<!-- gitnexus:start -->` block `` that appear
 * mid-sentence (#1041). A marker counts as section-position only when:
 *   - preceded by newline or start-of-file, AND
 *   - followed by newline, `\r` (CRLF files), or end-of-file.
 * The generator always emits each marker alone on its line, so this
 * matches every legitimate section and none of the inline mentions.
 *
 * `startFrom` lets the end-marker lookup start after the already-found
 * start marker, avoiding a scan from 0 and guaranteeing we never pick
 * up an end marker that appears earlier in the file than the start.
 */
function findSectionMarkerIndex(content: string, marker: string, startFrom = 0): number {
  let idx = content.indexOf(marker, startFrom);
  while (idx !== -1) {
    const atLineStart = idx === 0 || content[idx - 1] === '\n';
    const endPos = idx + marker.length;
    const atLineEnd =
      endPos === content.length || content[endPos] === '\n' || content[endPos] === '\r';
    if (atLineStart && atLineEnd) return idx;
    idx = content.indexOf(marker, idx + 1);
  }
  return -1;
}

/**
 * Generate the full GitNexus context content.
 *
 * Design principles (learned from real agent behavior and industry research):
 * - Inline critical workflows — skills are skipped 56% of the time (Vercel eval data)
 * - Use RFC 2119 language (MUST, NEVER, ALWAYS) — models follow imperative rules
 * - Three-tier boundaries (Always/When/Never) — proven to change model behavior
 * - Keep under 120 lines — adherence degrades past 150 lines
 * - Exact tool commands with parameters — vague directives get ignored
 * - Self-review checklist — forces model to verify its own work
 */
async function findGroupsContainingRegistryName(registryName: string): Promise<string[]> {
  const { listGroups, getDefaultGitnexusDir, getGroupDir } =
    await import('../core/group/storage.js');
  const { loadGroupConfig } = await import('../core/group/config-parser.js');
  const names = await listGroups();
  const hits: string[] = [];
  for (const g of names) {
    try {
      const config = await loadGroupConfig(getGroupDir(getDefaultGitnexusDir(), g));
      if (Object.values(config.repos).some((r) => r === registryName)) hits.push(config.name);
    } catch {
      // skip invalid or unreadable groups
    }
  }
  return hits;
}

/**
 * Strip backticks from a branch name before it is embedded in a Markdown
 * inline-code span (#1996 tri-review P1). validateBranchName already rejects
 * backticks for CLI/config/auto-detect inputs; this is the last-line defense at
 * the generation sink so the embedding is provably safe regardless of caller.
 */
export function markdownSafeBranch(branch: string): string {
  return branch.replace(/`/g, '');
}

/** Options for {@link generateGitNexusContent} (collapsed from positional
 *  params, #2188 review — six `undefined`s to reach `hasPdg` was the smell). */
export interface GitNexusContentOptions {
  generatedSkills?: GeneratedSkillInfo[];
  groupNames?: string[];
  noStats?: boolean;
  skipSkills?: boolean;
  /** Project-relative path to the runner `gitnexus analyze` drops next to the
   *  index (#1945). Referenced by docs so a single CLI-neutral command resolves
   *  the available runner (global `gitnexus` → `pnpm dlx` → `npx`) at call time. */
  runnerPath?: string;
  /** Default branch for the regression-compare example (#243). Configurable so
   *  projects on `develop`/`master`/etc. don't get `base_ref: "main"` rewritten
   *  back over their fix on every analyze. The value is embedded inside a
   *  Markdown inline-code span: validateBranchName rejects backticks upstream,
   *  and `markdownSafeBranch` strips any remaining backtick here as defense in
   *  depth, so JSON.stringify's quote/escape handling is sufficient and the
   *  branch cannot break out of the span (#1996 tri-review P1). */
  defaultBranch?: string;
  /** Whether the index was built with `--pdg` (#2086 M6). Gates the pdg_query
   *  line below — false (default) omits it, so a non-pdg index doesn't advertise
   *  a tool that only returns a "no PDG layer" note. */
  hasPdg?: boolean;
}

export function generateGitNexusContent(
  projectName: string,
  stats: RepoStats,
  opts: GitNexusContentOptions = {},
): string {
  const {
    generatedSkills,
    groupNames,
    noStats,
    skipSkills,
    runnerPath = '.gitnexus/run.cjs',
    defaultBranch = 'main',
    hasPdg = false,
  } = opts;
  const generatedRows =
    generatedSkills && generatedSkills.length > 0
      ? generatedSkills
          .map(
            (s) =>
              `| Work in the ${s.label} area (${s.symbolCount} symbols) | \`.claude/skills/${s.name}/SKILL.md\` |`,
          )
          .join('\n')
      : '';

  // Standard skill rows reference files installed by installSkills(). When
  // --skip-skills suppresses that install, these rows must be omitted — else
  // AGENTS.md/CLAUDE.md would direct agents to read files that don't exist.
  // Community skills (generatedRows) live directly under .claude/skills/ and
  // are independent of --skip-skills, so they remain when present.
  const standardSkillsRows = skipSkills
    ? ''
    : `| Understand architecture / "How does X work?" | \`.claude/skills/gitnexus-exploring/SKILL.md\` |
| Blast radius / "What breaks if I change X?" | \`.claude/skills/gitnexus-impact-analysis/SKILL.md\` |
| Trace bugs / "Why is X failing?" | \`.claude/skills/gitnexus-debugging/SKILL.md\` |
| Rename / extract / split / refactor | \`.claude/skills/gitnexus-refactoring/SKILL.md\` |
| Tools, resources, schema reference | \`.claude/skills/gitnexus-guide/SKILL.md\` |
| Index, status, clean, wiki CLI commands | \`.claude/skills/gitnexus-cli/SKILL.md\` |`;

  const tableBody = [standardSkillsRows, generatedRows].filter(Boolean).join('\n');
  const skillsTable = tableBody
    ? `| Task | Read this skill file |
|------|---------------------|
${tableBody}`
    : '';
  // Docs reference the project-local runner `gitnexus analyze` writes (#1945):
  // a single, CLI-neutral, machine-independent command (no per-machine churn,
  // #1706) that auto-selects the available runner at call time. Kept terse to
  // stay under the CLAUDE.md block token budget (#856); the cli skill carries the
  // full bootstrap + npm-11 fallback (`node.target is null` npx install crash).
  const runner = `node ${runnerPath}`;
  const bootstrapNote =
    `No \`${runnerPath}\` yet? \`npx gitnexus analyze\` ` +
    '(npm 11 crash → `npm i -g gitnexus`; #1939).';

  return `${GITNEXUS_START_MARKER}
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **${projectName}**${noStats ? '' : ` (${stats.nodes || 0} symbols, ${stats.edges || 0} relationships, ${stats.processes || 0} execution flows)`}. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run \`${runner} analyze\` from the project root — it auto-selects an available runner. ${bootstrapNote}

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run \`impact({target: "symbolName", direction: "upstream"})\` and report the blast radius (direct callers, affected processes, risk level) to the user.${
    hasPdg
      ? ` For unified PDG impact, add \`mode: "pdg"\` with optional \`line: <N>\` — it returns statement-level \`affectedStatements\` over CDG + REACHING_DEF and inter-procedural symbols in \`interproceduralByDepth\`/\`byDepth\`; no-layer/degraded PDG results are UNKNOWN-risk notes (\`--pdg\` layer).`
      : ''
  }
- **MUST run \`detect_changes()\` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: \`detect_changes({scope: "compare", base_ref: ${JSON.stringify(markdownSafeBranch(defaultBranch))}})\`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use \`query({search_query: "concept"})\` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use \`context({name: "symbolName"})\`.
- For security review, \`explain({target: "fileOrSymbol"})\` lists taint findings (source→sink flows; needs \`analyze --pdg\`).${
    hasPdg
      ? `\n- For control/data dependence, \`pdg_query({mode: "controls", target: "fileOrSymbol"})\` answers "under what condition does X run?" (CDG, incl. guard clauses) and \`pdg_query({mode: "flows", target, variable})\` traces "where does variable Y flow?" (REACHING_DEF). \`--pdg\` layer.`
      : ''
  }

## Never Do

- NEVER edit a function, class, or method without first running \`impact\` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use \`rename\` which understands the call graph.
- NEVER commit changes without running \`detect_changes()\` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| \`gitnexus://repo/${projectName}/context\` | Codebase overview, check index freshness |
| \`gitnexus://repo/${projectName}/clusters\` | All functional areas |
| \`gitnexus://repo/${projectName}/processes\` | All execution flows |
| \`gitnexus://repo/${projectName}/process/{name}\` | Step-by-step execution trace |

${
  groupNames && groupNames.length > 0
    ? `## Cross-Repo Groups

This repository is listed under GitNexus **group(s): ${groupNames.join(', ')}** (see \`~/.gitnexus/groups/\`). For cross-repo analysis, use MCP tools \`impact\`, \`query\`, and \`context\` with \`repo\` set to \`@<groupName>\` or \`@<groupName>/<memberPath>\` (paths match keys in that group’s \`group.yaml\`). Use \`group_list\` / \`group_sync\` for membership and sync. From the project root: \`${runner} group list\`, \`${runner} group sync <name>\`, \`${runner} group impact <name> --target <symbol> --repo <group-path>\` (the \`${runnerPath}\` path is repo-root-relative).

`
    : ''
}${
    skillsTable
      ? `## CLI

${skillsTable}

`
      : ''
  }${GITNEXUS_END_MARKER}`;
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or update GitNexus section in a file
 * - If file doesn't exist: create with GitNexus content
 * - If file exists without GitNexus section: append
 * - If file exists with GitNexus section: replace that section
 */
async function upsertGitNexusSection(
  filePath: string,
  content: string,
  projectName: string,
  stats: RepoStats,
  noStats?: boolean,
): Promise<'created' | 'updated' | 'appended' | 'preserved'> {
  const exists = await fileExists(filePath);

  if (!exists) {
    await fs.writeFile(filePath, content, 'utf-8');
    return 'created';
  }

  const existingContent = await fs.readFile(filePath, 'utf-8');

  // Check if GitNexus section already exists. Matching is restricted
  // to markers that occupy their own line so that inline prose
  // references (e.g. `` See the `<!-- gitnexus:start -->` block `` in
  // the shipped CLAUDE.md) are NOT treated as section delimiters
  // (#1041). The end-marker scan starts after the start-marker so it
  // can never pick up an earlier end in the file.
  const startIdx = findSectionMarkerIndex(existingContent, GITNEXUS_START_MARKER);
  const endIdx = findSectionMarkerIndex(
    existingContent,
    GITNEXUS_END_MARKER,
    startIdx === -1 ? 0 : startIdx,
  );

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const existingSection = existingContent.substring(
      startIdx,
      endIdx + GITNEXUS_END_MARKER.length,
    );

    // If the existing section contains <!-- gitnexus:keep -->, preserve the user's
    // custom layout and only update the stats line (node/edge/flow counts).
    // This lets teams trim the verbose default template to a lean format without
    // having it overwritten on every `gitnexus analyze`.
    //
    // Note: the keep-marker check operates on `existingSection` (the substring
    // between valid section markers identified by findSectionMarkerIndex), so
    // a keep marker in user prose OUTSIDE the GitNexus block has no effect.
    if (existingSection.includes('<!-- gitnexus:keep -->')) {
      // Build the new stats line from the caller-provided values directly.
      // We do NOT re-extract from `content` because:
      //   (a) first-bold extraction is fragile if the template evolves
      //   (b) the parenthesized-text fallback can match unrelated tuples
      //       like `({target: "symbolName", direction: "upstream"})`
      //       when noStats is set
      // Passing projectName + stats explicitly makes the contract obvious.
      // --no-stats wins in the keep path too (#1706): a lean block committed
      // to git would otherwise churn the volatile counts on every analyze,
      // producing no-value merge conflicts between branches. Under noStats we
      // drop the parenthetical but still refresh the project name so renames
      // propagate.
      const newStatsInner = `${stats.nodes || 0} symbols, ${stats.edges || 0} relationships, ${stats.processes || 0} execution flows`;
      const statsLine = noStats
        ? `Indexed as **${projectName}**`
        : `Indexed as **${projectName}** (${newStatsInner})`;

      // Match either canonical phrasing at line start (`^` with `m` flag) so we
      // cannot replace prose embedded mid-paragraph. Deliberately no `$`: text
      // after the line on the same line (e.g. ". MCP tools.") stays intact.
      // The parenthetical is optional so a count-free line left by a prior
      // --no-stats run still matches — letting the name refresh, and letting
      // counts return if --no-stats is later dropped.
      const statsPattern = /^(?:Indexed as|indexed by GitNexus as) \*\*[^*]+\*\*(?: \([^)]+\))?/m;

      if (statsPattern.test(existingSection)) {
        const updatedSection = existingSection.replace(statsPattern, statsLine);
        const before = existingContent.substring(0, startIdx);
        const after = existingContent.substring(endIdx + GITNEXUS_END_MARKER.length);
        await fs.writeFile(filePath, (before + updatedSection + after).trim() + '\n', 'utf-8');
        return 'updated';
      }
      // Keep marker present but no stats line matched. Section is preserved
      // unchanged on disk; return a distinct status so callers/CLI output
      // don't mis-report this as 'updated' (which would imply a write).
      return 'preserved';
    }

    // No keep marker — replace existing section with full verbose content
    const before = existingContent.substring(0, startIdx);
    const after = existingContent.substring(endIdx + GITNEXUS_END_MARKER.length);
    const newContent = before + content + after;
    await fs.writeFile(filePath, newContent.trim() + '\n', 'utf-8');
    return 'updated';
  }

  // Append new section
  const newContent = existingContent.trim() + '\n\n' + content + '\n';
  await fs.writeFile(filePath, newContent, 'utf-8');
  return 'appended';
}

/**
 * Install GitNexus skills as direct children of .claude/skills/
 * Works natively with Claude Code, Cursor, and GitHub Copilot
 */
async function installSkills(repoPath: string): Promise<string[]> {
  const skillsDir = path.join(repoPath, '.claude', 'skills');
  const legacySkillsDir = path.join(skillsDir, 'gitnexus');
  const installedSkills: string[] = [];

  // Skill definitions bundled with the package
  const skills = [
    {
      name: 'gitnexus-exploring',
      description:
        'Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: "How does X work?", "What calls this function?", "Show me the auth flow"',
    },
    {
      name: 'gitnexus-debugging',
      description:
        'Use when the user is debugging a bug, tracing an error, or asking why something fails. Examples: "Why is X failing?", "Where does this error come from?", "Trace this bug"',
    },
    {
      name: 'gitnexus-impact-analysis',
      description:
        'Use when the user wants to know what will break if they change something, or needs safety analysis before editing code. Examples: "Is it safe to change X?", "What depends on this?", "What will break?"',
    },
    {
      name: 'gitnexus-refactoring',
      description:
        'Use when the user wants to rename, extract, split, move, or restructure code safely. Examples: "Rename this function", "Extract this into a module", "Refactor this class", "Move this to a separate file"',
    },
    {
      name: 'gitnexus-guide',
      description:
        'Use when the user asks about GitNexus itself — available tools, how to query the knowledge graph, MCP resources, graph schema, or workflow reference. Examples: "What GitNexus tools are available?", "How do I use GitNexus?"',
    },
    {
      name: 'gitnexus-cli',
      description:
        'Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: "Index this repo", "Reanalyze the codebase", "Generate a wiki"',
    },
  ];

  for (const skill of skills) {
    const skillDir = path.join(skillsDir, skill.name);
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
      // Create skill directory
      await fs.mkdir(skillDir, { recursive: true });

      // Try to read from package skills directory
      const packageSkillPath = path.join(__dirname, '..', '..', 'skills', `${skill.name}.md`);
      let skillContent: string;

      try {
        skillContent = await fs.readFile(packageSkillPath, 'utf-8');
      } catch {
        // Fallback: generate minimal skill content
        skillContent = `---
name: ${skill.name}
description: ${skill.description}
---

# ${skill.name.charAt(0).toUpperCase() + skill.name.slice(1)}

${skill.description}

Use GitNexus tools to accomplish this task.
`;
      }

      await fs.writeFile(skillPath, skillContent, 'utf-8');
      installedSkills.push(skill.name);

      // Previous releases installed these known standard skills one level too
      // deep. Remove only the child owned by this installer; unknown siblings
      // under the legacy grouping directory may be user-authored and survive.
      try {
        await fs.rm(path.join(legacySkillsDir, skill.name), { recursive: true, force: true });
      } catch (err) {
        logger.warn({ err }, `Warning: Could not remove legacy skill ${skill.name}:`);
      }
    } catch (err) {
      // Skip on error, don't fail the whole process
      logger.warn({ err }, `Warning: Could not install skill ${skill.name}:`);
    }
  }

  return installedSkills;
}

/**
 * Generate AI context files after indexing
 */
export async function generateAIContextFiles(
  repoPath: string,
  storagePath: string,
  projectName: string,
  stats: RepoStats,
  generatedSkills?: GeneratedSkillInfo[],
  options?: AIContextOptions,
): Promise<{ files: string[] }> {
  const groupNames = await findGroupsContainingRegistryName(projectName);

  // Drop a project-local runner next to the index (#1945) so the generated docs
  // can reference one CLI-neutral command that resolves the available runner at
  // call time. It is a copy of the canonical self-contained resolver, which the
  // CLI and hooks already share; failure to copy is non-fatal (docs carry a
  // bootstrap fallback). `runnerPath` is project-relative with POSIX separators
  // so the emitted command is identical across platforms.
  const runnerPath = path.relative(repoPath, path.join(storagePath, 'run.cjs')).replace(/\\/g, '/');
  try {
    const runnerSrc = path.join(
      __dirname,
      '..',
      '..',
      'hooks',
      'claude',
      'resolve-analyze-cmd.cjs',
    );
    await fs.mkdir(storagePath, { recursive: true });
    await fs.copyFile(runnerSrc, path.join(storagePath, 'run.cjs'));
  } catch (err) {
    logger.warn(`Could not write GitNexus runner to ${runnerPath}: ${String(err)}`);
  }

  const content = generateGitNexusContent(projectName, stats, {
    generatedSkills,
    groupNames,
    noStats: options?.noStats,
    skipSkills: options?.skipSkills,
    runnerPath,
    defaultBranch: options?.defaultBranch ?? 'main',
    hasPdg: options?.hasPdg ?? false,
  });
  const createdFiles: string[] = [];

  if (!options?.skipAgentsMd) {
    // Create AGENTS.md (standard for Cursor, Windsurf, OpenCode, Cline, etc.)
    const agentsPath = path.join(repoPath, 'AGENTS.md');
    const agentsResult = await upsertGitNexusSection(
      agentsPath,
      content,
      projectName,
      stats,
      options?.noStats,
    );
    createdFiles.push(`AGENTS.md (${agentsResult})`);

    // Create CLAUDE.md (for Claude Code)
    const claudePath = path.join(repoPath, 'CLAUDE.md');
    const claudeResult = await upsertGitNexusSection(
      claudePath,
      content,
      projectName,
      stats,
      options?.noStats,
    );
    createdFiles.push(`CLAUDE.md (${claudeResult})`);
  } else {
    createdFiles.push('AGENTS.md (skipped via --skip-agents-md)');
    createdFiles.push('CLAUDE.md (skipped via --skip-agents-md)');
  }

  // Install standard skills directly under .claude/skills/ (unless --skip-skills)
  if (!options?.skipSkills) {
    const installedSkills = await installSkills(repoPath);
    if (installedSkills.length > 0) {
      createdFiles.push(`.claude/skills/gitnexus-*/ (${installedSkills.length} skills)`);
    }
  } else {
    createdFiles.push('.claude/skills/gitnexus-*/ (skipped via --skip-skills)');
  }

  return { files: createdFiles };
}

/**
 * Refresh only the `base_ref: "..."` value inside the GitNexus block of an
 * already-generated AGENTS.md / CLAUDE.md, in place (#1996 tri-review P2).
 *
 * The `alreadyUpToDate` analyze fast path returns before the normal
 * {@link generateAIContextFiles} call, so a changed `.gitnexusrc` defaultBranch
 * (or `--default-branch`) would otherwise not take effect until the next
 * re-index. This does a surgical line update that preserves the rest of the
 * block — including community-skill rows written by a prior `--skills` run —
 * rather than regenerating (which would drop those rows on a no-`--skills` run).
 *
 * Best-effort: missing files, a missing/blank block, or a block with no
 * `base_ref` line (e.g. a user-trimmed keep block) are silently skipped. Writes
 * only when the value actually changes, so a routine up-to-date run is a no-op.
 */
export async function refreshBaseRefLine(
  repoPath: string,
  defaultBranch: string,
  options?: { skipAgentsMd?: boolean },
): Promise<{ files: string[] }> {
  if (options?.skipAgentsMd) return { files: [] };
  const replacement = `base_ref: ${JSON.stringify(markdownSafeBranch(defaultBranch))}`;
  const updated: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const filePath = path.join(repoPath, name);
    if (!(await fileExists(filePath))) continue;
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    const startIdx = findSectionMarkerIndex(content, GITNEXUS_START_MARKER);
    if (startIdx === -1) continue;
    const endIdx = findSectionMarkerIndex(content, GITNEXUS_END_MARKER, startIdx);
    if (endIdx === -1 || endIdx <= startIdx) continue;
    const blockEnd = endIdx + GITNEXUS_END_MARKER.length;
    const block = content.substring(startIdx, blockEnd);
    // Only the generated regression example carries a base_ref line, and only
    // one per block; replace its quoted value while leaving the rest untouched.
    const newBlock = block.replace(/base_ref: "(?:[^"\\]|\\.)*"/, replacement);
    if (newBlock === block) continue; // no base_ref line present, or already current
    const newContent = content.substring(0, startIdx) + newBlock + content.substring(blockEnd);
    try {
      await fs.writeFile(filePath, newContent, 'utf-8');
      updated.push(name);
    } catch {
      // best-effort — never fail analyze over a context refresh
    }
  }
  return { files: updated };
}
