/**
 * AI Context Generator
 *
 * Creates AGENTS.md and CLAUDE.md with full inline GitNexus context.
 * AGENTS.md is the standard read by Cursor, Windsurf, OpenCode, Codex, Cline, CodeBuddy, Qoder, etc.
 * CLAUDE.md is for Claude Code which only reads that file.
 */

import { GITNEXUS_DIR } from '../storage/storage-constants.js';
import { storeRootOfCheckoutSlot } from '../storage/shared-store.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { type GeneratedSkillInfo } from './generated-skill.js';
import { STANDARD_SKILL_CATALOG } from './standard-skills.js';
import { isEnoent } from './editor-targets.js';
import { selectedInstructionFiles, type InstructionFile } from './analyze-options.js';
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
  instructionFile?: InstructionFile;
  /** Explicit analysis refreshes displayed counts. Background updates avoid count-only writes. */
  refreshCounts?: boolean;
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
  /** Whether this index includes opt-in Spring Actuator runtime evidence. */
  hasSpringActuator?: boolean;
}

const GITNEXUS_START_MARKER = '<!-- gitnexus:start -->';
const GITNEXUS_END_MARKER = '<!-- gitnexus:end -->';
// Matches the template and lean headers, including wrapped Markdown counts.
const STATS_LINE_PATTERN =
  /^((?:This project is )?(?:Indexed as|indexed by GitNexus as)) (\*\*[^*\n]+\*\*)(\s+\(\d+\s+symbols,\s+\d+\s+relationships,\s+\d+\s+execution\s+flows\))?/m;

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

export async function hasInstructionBlock(filePath: string): Promise<boolean> {
  const content = await fs.readFile(filePath, 'utf8').catch(() => '');
  const start = findSectionMarkerIndex(content, GITNEXUS_START_MARKER);
  return start >= 0 && findSectionMarkerIndex(content, GITNEXUS_END_MARKER, start) >= 0;
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

function regressionReviewGuidance(defaultBranch: string, runner?: string): string {
  const safeBranch = markdownSafeBranch(defaultBranch);
  const target = JSON.stringify(safeBranch);
  const cliFallback = runner
    ? ` or \`${runner} detect-changes --scope compare --base-ref "<merge-base SHA>" --repo .\``
    : '';
  return `For regression review, fetch target branch ${target} from its remote; compute its merge base with the reviewed HEAD and pass that SHA to \`detect_changes({scope: "compare", base_ref: "<merge-base SHA>"})\`${cliFallback}.`;
}

/** Options for {@link generateGitNexusContent} (collapsed from positional
 *  params, #2188 review — six `undefined`s to reach `hasPdg` was the smell). */
export interface GitNexusContentOptions {
  generatedSkills?: GeneratedSkillInfo[];
  /** Managed block from this file, used when community skills were not regenerated. */
  previousSection?: string;
  groupNames?: string[];
  noStats?: boolean;
  skipSkills?: boolean;
  /** Project-relative path to the runner `gitnexus analyze` drops next to the
   *  index (#1945). Referenced by docs so a single CLI-neutral command resolves
   *  the available runner (global `gitnexus` → `pnpm dlx` → `bunx` → `npx`) at
   *  call time. */
  runnerPath?: string;
  /** Default target branch for the regression-review guidance (#243, #3509).
   *  This is a target hint only: compare scope must receive the exact merge-base
   *  SHA, never the moving branch tip. The value is embedded inside a
   *  Markdown inline-code span: validateBranchName rejects backticks upstream,
   *  and `markdownSafeBranch` strips any remaining backtick here as defense in
   *  depth, so JSON.stringify's quote/escape handling is sufficient and the
   *  branch cannot break out of the span (#1996 tri-review P1). */
  defaultBranch?: string;
  /** Whether the index was built with `--pdg` (#2086 M6). Gates the pdg_query
   *  line below — false (default) omits it, so a non-pdg index doesn't advertise
   *  a tool that only returns a "no PDG layer" note. */
  hasPdg?: boolean;
  /** Whether Route nodes may carry Spring Actuator runtime evidence. */
  hasSpringActuator?: boolean;
}

function retainedCommunitySkillRows(section: string, noStats?: boolean): string {
  const rows =
    section.match(
      /^\| Work in the [^\n|]+ area(?: \(\d+ symbols\))?[ \t]*\|[ \t]*`\.claude\/skills\/[^/`\n]+\/SKILL\.md`[ \t]*\|[ \t]*$/gm,
    ) ?? [];
  return rows
    .map((row) => (noStats ? row.replace(/ \(\d+ symbols\)(?=[ \t]*\|)/, '') : row))
    .join('\n');
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
    hasSpringActuator = false,
  } = opts;
  const generatedRows =
    generatedSkills
      ?.map(
        (s) =>
          `| Work in the ${s.label} area${noStats ? '' : ` (${s.symbolCount} symbols)`} | \`.claude/skills/${s.name}/SKILL.md\` |`,
      )
      .join('\n') ?? retainedCommunitySkillRows(opts.previousSection ?? '', noStats);

  // Standard skill rows reference files installed by installSkills(). When
  // --skip-skills suppresses that install, these rows must be omitted — else
  // AGENTS.md/CLAUDE.md would direct agents to read files that don't exist.
  // Community skills (generatedRows) live directly under .claude/skills/ and
  // are independent of --skip-skills, so they remain when present.
  const standardSkillsRows = skipSkills
    ? ''
    : STANDARD_SKILL_CATALOG.filter((skill) => skill.distributions.project)
        .map((skill) => `| ${skill.agentTableTask} | \`.claude/skills/${skill.name}/SKILL.md\` |`)
        .join('\n');

  const tableBody = [standardSkillsRows, generatedRows].filter(Boolean).join('\n');
  const skillsTable = tableBody
    ? `| Task | Read this skill file |
| --- | --- |
${tableBody}`
    : '';
  // Docs reference the project-local runner `gitnexus analyze` writes (#1945):
  // a single, CLI-neutral, machine-independent command (no per-machine churn,
  // #1706) that auto-selects the available runner at call time. Kept terse to
  // stay under the CLAUDE.md block token budget (#856); the cli skill carries the
  // full bootstrap + npm-11 fallback (`node.target is null` npx install crash).
  const runner = `node ${runnerPath}`;
  // Bootstrap names every install-free one-shot rather than the one this machine
  // resolves to: the block is committed, so a host-specific command would make
  // two contributors on different package managers rewrite it at each other on
  // every analyze (the per-machine churn of #1706). `bunx` is listed because a
  // bun-only machine has no npm, npx or pnpm at all, and the npx-only note left
  // it with a bootstrap command it could not run.
  const bootstrapNote =
    `No \`${runnerPath}\`? Bootstrap with \`npx\`, \`bunx\`, or \`pnpm dlx\`; ` +
    'e.g. `bunx gitnexus@latest analyze` (#1939).';

  // This block is injected into every user's repo and its total size is capped
  // by test (ai-context.test.ts, #856) — a new bullet or clause has to be paid
  // for by trimming an existing one.
  //
  // The detect_changes bullet carries the degraded-result rule (#2915): a run
  // that sets `partial` (a graph query failed) or `truncated` (the changed-symbol
  // listing was capped) is not the pre-commit gate passing, and `partial` pairs
  // routinely with changed_count:0 — the exact shape that printed "No changes
  // detected." and exited 0 on a broken analysis. Same reasoning as the
  // `risk: UNKNOWN` bullet below: the tool could not answer, so its zero is not
  // an all-clear.
  return `${GITNEXUS_START_MARKER}
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **${projectName}**${noStats ? '' : ` (${stats.nodes || 0} symbols, ${stats.edges || 0} relationships, ${stats.processes || 0} execution flows)`}.

> Index stale? Run \`${runner} analyze --index-only\`. ${bootstrapNote}
> On query/context/impact/cypher object results, read staleness.status and branch/lastCommit. Re-analyze only for behind or diverged — current is clone HEAD, not main.

## Always Do

- **MUST run impact before code/config/test edits.** Use \`impact({target: "symbolName", direction: "upstream"})\` or \`${runner} impact "symbolName" --direction upstream --repo .\`; report callers/processes/risk. Never substitute grep for graph analysis. Docs-only exempt.${
    hasPdg
      ? ` For unified PDG impact, add \`mode: "pdg"\` with optional \`line: <N>\` — it returns statement-level \`affectedStatements\` over CDG + REACHING_DEF and inter-procedural symbols in \`interproceduralByDepth\`/\`byDepth\`; no-layer/degraded PDG results are UNKNOWN-risk notes (\`--pdg\` layer). CLI equivalent: \`${runner} impact "symbolName" --direction upstream --mode pdg --line <N> --repo .\`.`
      : ''
  }
- **MUST analyze changes before commit.** Run \`detect_changes({scope: "all"})\` or \`${runner} detect-changes --scope all --repo .\`. \`partial: true\` or \`truncated: true\` is not a clean check — a zero means unseen, not unaffected; re-run it. ${regressionReviewGuidance(defaultBranch, runner)}
- MUST warn on HIGH/CRITICAL \`risk\` pre-edit; never use \`riskSharedAxes\` to waive a HIGH/CRITICAL \`risk\` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat \`risk: UNKNOWN\` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). \`impact\` pairs \`UNKNOWN\` with a \`riskNote\` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use \`query({search_query: "concept"})\` for concepts/flows, \`context({name: "symbolName"})\` for a named symbol, or \`impact\` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/\`UNKNOWN\`/literals.${
    hasSpringActuator
      ? '\n- Spring Actuator runtime evidence is enabled. A Route is authoritative only when `runtimeConfirmed === true`; `runtimeSource` is provenance and may also describe conflicts. Snapshot values are never persisted.'
      : ''
  }
- For security review, \`explain({target: "fileOrSymbol"})\` lists taint findings (source→sink flows; needs \`analyze --pdg\`).${
    hasPdg
      ? `\n- For control/data dependence, \`pdg_query({mode: "controls", target: "fileOrSymbol"})\` answers "under what condition does X run?" (CDG, incl. guard clauses) and \`pdg_query({mode: "flows", target, variable})\` traces "where does variable Y flow?" (REACHING_DEF). \`--pdg\` layer.`
      : ''
  }

## Never Do

- NEVER edit code/config/tests without MCP/CLI impact.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read \`UNKNOWN\` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use \`rename\` with \`dry_run: true\`, review semantic spans and coverage, then apply with \`dry_run: false\` and its \`plan_token\`.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| \`gitnexus://repo/${projectName}/context\` | Codebase overview, check index freshness |
| \`gitnexus://repo/${projectName}/clusters\` | All functional areas |
| \`gitnexus://repo/${projectName}/processes\` | All execution flows |
| \`gitnexus://repo/${projectName}/process/{processName}\` | Step-by-step execution trace |
| \`gitnexus://repo/${projectName}/schema\` | Graph schema for Cypher |

\`gitnexus://repos\`, \`gitnexus://setup\`, \`gitnexus://repo/${projectName}/cluster/{clusterName}\`, and group \`contracts\`/\`status\` URIs: see \`gitnexus-guide\`.

${
  groupNames && groupNames.length > 0
    ? `## Cross-Repo Groups

This repository is listed under GitNexus **group(s): ${groupNames.join(', ')}** (see \`~/.gitnexus/groups/\`). For cross-repo analysis, use MCP tools \`impact\`, \`query\`, and \`context\` with \`repo\` set to \`@<groupName>\` or \`@<groupName>/<memberPath>\` (paths match keys in that group’s \`group.yaml\`). Use \`group_list\` / \`group_sync\` for membership and sync. From the project root: \`${runner} group list\`, \`${runner} group sync <name>\`, \`${runner} group impact <name> --target <symbol> --repo <group-path>\` (the \`${runnerPath}\` path is repo-root-relative). **Warning:** \`group sync\` / \`group_sync\` writes the group's contract registry.

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
 * A fence opener, optionally behind the list-item or block-quote markers that
 * open on the same line (`- ```sh`): group 1 is that marker prefix, group 2
 * the fence, group 3 the info string.
 */
const FENCE_OPENER = /^((?: {0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]))*) {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * A line that cannot be the text of a setext heading: an ATX heading, a block
 * quote, a list item, or a thematic break (also the shape of a setext `---`
 * underline). A row of `=` under one of these is paragraph text, not a title.
 */
const NOT_SETEXT_TEXT =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)|([-*_])[ \t]*(?:\1[ \t]*){2,}$)/;

/**
 * Whether `markdown` has a title of its own: an ATX `# Title`, a setext title
 * underlined with `=`, or a `title` key in closed YAML front matter (which
 * markdownlint's MD025 counts as the document title). Fenced code, HTML
 * comments and the rest of the front matter can contain heading examples
 * without giving the file a title.
 */
function hasTopLevelHeading(markdown: string): boolean {
  const lines = markdown.replace(/^\uFEFF/, '').split('\n');
  let start = 0;
  if (/^---[ \t]*$/.test(lines[0])) {
    const end = lines.findIndex((line, i) => i > 0 && /^---[ \t]*$/.test(line));
    if (end !== -1) {
      // markdownlint's default `front_matter_title` pattern.
      if (lines.slice(1, end).some((line) => /^\s*"?title"?\s*[:=]/i.test(line))) return true;
      start = end + 1;
    }
  }
  // `inside` is set for a fence opened in a list item or block quote: the
  // shape a later line must have to still belong to that container.
  let fence: { char: string; length: number; inside?: RegExp } | undefined;
  let inComment = false;
  let previous = '';
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (fence?.inside && line.trim() !== '' && !fence.inside.test(line)) {
      // The list item or block quote ended, and with it any fence still open
      // inside (one closed deeper than three spaces is not seen as closed
      // below); this line is ordinary content again.
      fence = undefined;
    }
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = undefined;
      }
      previous = '';
      continue;
    }
    if (inComment || /^ {0,3}<!--/.test(line)) {
      inComment = !line.includes('-->');
      previous = '';
      continue;
    }
    const opener = FENCE_OPENER.exec(line);
    // Backtick fence info strings cannot contain backticks (CommonMark §4.5).
    if (opener && (opener[2][0] !== '`' || !opener[3].includes('`'))) {
      const inside =
        opener[1] === ''
          ? undefined
          : opener[1].includes('>')
            ? /^ {0,3}>/
            : new RegExp(`^ {${line.indexOf(opener[2])}}`);
      fence = { char: opener[2][0], length: opener[2].length, inside };
      previous = '';
      continue;
    }
    if (/^ {0,3}#(?:[ \t]|$)/.test(line)) return true;
    if (
      /^ {0,3}=+[ \t]*$/.test(line) &&
      previous.trim() !== '' &&
      !NOT_SETEXT_TEXT.test(previous)
    ) {
      return true;
    }
    previous = line;
  }
  return false;
}

/**
 * The block opens with a level-1 heading, which is right for a file GitNexus
 * creates. Inside a file that already has its own title, a second level-1
 * heading breaks markdownlint's MD025 (single-title), so the block's headings
 * move down one level there (#2774). Every line of the block that starts with
 * `#` is one of its own headings.
 */
function nestUnderExistingTitle(block: string, surrounding: string): string {
  return hasTopLevelHeading(surrounding) ? block.replace(/^(#{1,5}) /gm, '#$1 ') : block;
}

/**
 * Replace the block's volatile counts — the header parenthetical and the
 * per-cluster symbol counts in the skills table — with fixed placeholders, so
 * two renderings that differ only in those numbers compare equal.
 *
 * Placeholders rather than deletions: `--no-stats` REMOVES the parenthetical,
 * which must still be written through. Deleting instead of substituting would
 * make a with-counts block and a without-counts block compare equal, and the
 * flag would silently stop taking effect on an already-injected file.
 */
function stripVolatileCounts(section: string): string {
  return section
    .replace(/ \(\d+ symbols, \d+ relationships, \d+ execution flows\)/g, ' (<counts>)')
    .replace(/ \(\d+ symbols\)/g, ' (<count>)');
}

/**
 * Create or update GitNexus section in a file
 * - If file doesn't exist: create with GitNexus content
 * - If file exists without GitNexus section: append
 * - Replace an existing section on material changes. Explicit analysis also
 *   refreshes displayed counts. Background updates skip count-only writes (#2907).
 */
async function upsertGitNexusSection(
  filePath: string,
  render: (previousSection?: string) => string,
  projectName: string,
  stats: RepoStats,
  noStats?: boolean,
  refreshCounts = false,
): Promise<'created' | 'updated' | 'appended' | 'preserved'> {
  const comparable = refreshCounts ? (section: string) => section : stripVolatileCounts;
  const exists = await fileExists(filePath);

  if (!exists) {
    // Same `.trim() + '\n'` shape the update paths write. Creating without the
    // trailing newline made the NEXT analyze dirty a freshly committed file
    // even at unchanged counts, purely to append it (#2907).
    await fs.writeFile(filePath, render().trim() + '\n', 'utf-8');
    return 'created';
  }

  // The block is generated with LF. A file checked out with CRLF (Windows,
  // `core.autocrlf`) used to get the block written in LF inside its CRLF
  // prose, so git saw mixed endings and a dirty tree after every reindex
  // (#3688). The file's own ending is kept: the content is normalised to LF
  // for the marker search and the comparisons below, and written back in the
  // ending it had.
  const rawContent = await fs.readFile(filePath, 'utf-8');
  const eol = detectLineEnding(rawContent);
  const existingContent = rawContent.replace(/\r\n/g, '\n');
  // A file the previous writer left with mixed endings (CRLF prose, LF block)
  // compares equal once normalised, so the paths below that keep the file as
  // it is would leave the mixed bytes in place. Such a file is written back
  // once, in its own ending, with its text untouched.
  const repairLineEndings = async (): Promise<'updated' | 'preserved'> => {
    if (rawContent === toLineEnding(existingContent, eol)) return 'preserved';
    await writeWithLineEnding(filePath, existingContent, eol);
    return 'updated';
  };

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

      // Match either canonical phrasing at line start (`^` with `m` flag) so we
      // cannot replace prose embedded mid-paragraph. Deliberately no `$`: text
      // after the line on the same line (e.g. ". MCP tools.") stays intact.
      // The parenthetical is optional so a count-free line left by a prior
      // --no-stats run still matches — letting the name refresh, and letting
      // counts return if --no-stats is later dropped.
      const statsMatch = existingSection.match(STATS_LINE_PATTERN);

      if (statsMatch) {
        const statsPrefix = statsMatch[1];
        const customParenthetical =
          !statsMatch[3] &&
          /^\s*\(/.test(existingSection.slice(statsMatch.index! + statsMatch[0].length));
        const statsLine =
          noStats || customParenthetical
            ? `${statsPrefix} **${projectName}**`
            : `${statsPrefix} **${projectName}** (${newStatsInner})`;
        const updatedSection = existingSection.replace(STATS_LINE_PATTERN, () => statsLine);
        // Background refreshes preserve count-only changes in lean blocks (#2907).
        if (comparable(updatedSection) === comparable(existingSection)) {
          return repairLineEndings();
        }
        const before = existingContent.substring(0, startIdx);
        const after = existingContent.substring(endIdx + GITNEXUS_END_MARKER.length);
        await writeWithLineEnding(filePath, before + updatedSection + after, eol);
        return 'updated';
      }
      // Keep marker present but no stats line matched. Section is preserved
      // unchanged on disk; return a distinct status so callers/CLI output
      // don't mis-report this as 'updated' (which would imply a write).
      return repairLineEndings();
    }

    // No keep marker — replace existing section with full verbose content,
    // unless the counts are the only thing that moved (#2907).
    const before = existingContent.substring(0, startIdx);
    const after = existingContent.substring(endIdx + GITNEXUS_END_MARKER.length);
    // The write below trims the file, which can change what its first lines
    // are (a blank line before front matter, an indented first line), so the
    // title is looked for in the text as it will be written.
    const placed = nestUnderExistingTitle(render(existingSection), before.trimStart() + after);
    if (comparable(existingSection) === comparable(placed)) {
      return repairLineEndings();
    }
    const newContent = before + placed + after;
    const countOnly =
      refreshCounts && stripVolatileCounts(existingSection) === stripVolatileCounts(placed);
    await writeWithLineEnding(filePath, countOnly ? newContent : newContent.trim() + '\n', eol);
    return 'updated';
  }

  // Append new section, deciding its heading level from the trimmed text that
  // is written rather than the text that was read.
  const kept = existingContent.trim();
  const newContent = kept + '\n\n' + nestUnderExistingTitle(render(), kept) + '\n';
  await writeWithLineEnding(filePath, newContent, eol);
  return 'appended';
}

/** The line ending of the first line break in `content`; LF when there is none. */
function detectLineEnding(content: string): '\n' | '\r\n' {
  const firstBreak = content.indexOf('\n');
  return firstBreak > 0 && content[firstBreak - 1] === '\r' ? '\r\n' : '\n';
}

function toLineEnding(lfContent: string, eol: '\n' | '\r\n'): string {
  return eol === '\n' ? lfContent : lfContent.replace(/\n/g, eol);
}

/** Write LF text in the file's own line ending. */
async function writeWithLineEnding(
  filePath: string,
  lfContent: string,
  eol: '\n' | '\r\n',
): Promise<void> {
  await fs.writeFile(filePath, toLineEnding(lfContent, eol), 'utf-8');
}

/**
 * Some agents read skills from a repo-local `.agents/skills/` directory and
 * prefer it over the global `~/.agents/skills/` install. When the repo contains
 * an `.agents/` directory, skills written to `.claude/skills/` are mirrored
 * there too so those agents serve the up-to-date copies.
 */
export async function shouldMirrorSkillsToAgents(repoPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(repoPath, '.agents'));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

const SKILL_PRESERVE_HINT =
  'delete the file to refresh from the bundled template, or pass --skip-skills to skip skill install';

async function readUtf8IfPresent(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

function skillBytesDiverge(existing: string | null, bundled: string): boolean {
  return existing !== null && existing !== bundled;
}

/** Write bundled skill bytes unless an existing file already differs. */
async function writeSkillUnlessDivergent(filePath: string, content: string): Promise<boolean> {
  const existing = await readUtf8IfPresent(filePath);
  if (skillBytesDiverge(existing, content)) {
    logger.warn(`Preserved customized skill ${filePath}; ${SKILL_PRESERVE_HINT}.`);
    return true;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  return false;
}

async function inspectLegacySkillDir(
  legacyDir: string,
): Promise<{ nestedExisting: string | null; hasSiblings: boolean } | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(legacyDir);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  const nestedExisting = entries.includes('SKILL.md')
    ? await fs.readFile(path.join(legacyDir, 'SKILL.md'), 'utf-8')
    : null;
  return {
    nestedExisting,
    hasSiblings: entries.some((entry) => entry !== 'SKILL.md'),
  };
}

function formatSkillInstallLine(
  prefix: string,
  total: number,
  preserved: number,
  allWrittenSuffix: string,
  partialSuffix: string,
): string {
  if (preserved > 0) {
    return `${prefix} (${total - preserved} written, ${preserved} ${partialSuffix})`;
  }
  return `${prefix} (${total} ${allWrittenSuffix})`;
}

/**
 * Install GitNexus skills as direct children of .claude/skills/
 * Works natively with Claude Code, Cursor, and GitHub Copilot.
 * Mirrored to .agents/skills/ when .agents/ exists.
 */
async function installSkills(repoPath: string): Promise<{
  skills: string[];
  agentsMirror: boolean;
  claudePreserved: number;
  agentsPreserved: number;
  legacyPreserved: number;
}> {
  const skillsDir = path.join(repoPath, '.claude', 'skills');
  const legacySkillsDir = path.join(skillsDir, 'gitnexus');
  const installedSkills: string[] = [];
  let claudePreserved = 0;
  let agentsPreserved = 0;
  let legacyPreserved = 0;
  const agentsMirror = await shouldMirrorSkillsToAgents(repoPath);

  for (const skill of STANDARD_SKILL_CATALOG.filter(
    (entry) => entry.distributions.project && entry.distributions.npm,
  )) {
    const skillDir = path.join(skillsDir, skill.name);
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
      // Try to read from package skills directory
      const packageSkillPath = path.join(__dirname, '..', '..', 'skills', `${skill.name}.md`);
      let skillContent: string;

      try {
        skillContent = await fs.readFile(packageSkillPath, 'utf-8');
      } catch {
        // Fallback: generate minimal skill content
        skillContent = `---
name: ${skill.name}
description: ${skill.fallbackDescription}
---

# ${skill.name.charAt(0).toUpperCase() + skill.name.slice(1)}

${skill.fallbackDescription}

Use GitNexus tools to accomplish this task.
`;
      }

      if (await writeSkillUnlessDivergent(skillPath, skillContent)) claudePreserved += 1;

      // Mirror to .agents/skills/ for agents that read repo-local skills
      if (agentsMirror) {
        try {
          const agentsSkillPath = path.join(repoPath, '.agents', 'skills', skill.name, 'SKILL.md');
          if (await writeSkillUnlessDivergent(agentsSkillPath, skillContent)) agentsPreserved += 1;
        } catch (err) {
          logger.warn({ err }, `Warning: Could not mirror skill ${skill.name} to .agents/skills:`);
        }
      }

      installedSkills.push(skill.name);

      // Previous releases installed these known standard skills one level too
      // deep. Remove only the child owned by this installer; unknown siblings
      // under the legacy grouping directory may be user-authored and survive.
      try {
        const legacyDir = path.join(legacySkillsDir, skill.name);
        const nestedSkill = path.join(legacyDir, 'SKILL.md');
        const leftover = await inspectLegacySkillDir(legacyDir);
        if (leftover !== null && skillBytesDiverge(leftover.nestedExisting, skillContent)) {
          logger.warn(`Preserved customized skill ${nestedSkill}; ${SKILL_PRESERVE_HINT}.`);
          legacyPreserved += 1;
        } else if (leftover?.hasSiblings) {
          logger.warn(
            `Preserved legacy skill directory ${legacyDir} because it contains operator-owned files.`,
          );
          legacyPreserved += 1;
        } else if (leftover !== null) {
          await fs.rm(legacyDir, { recursive: true, force: true });
        }
      } catch (err) {
        logger.warn({ err }, `Warning: Could not remove legacy skill ${skill.name}:`);
      }
    } catch (err) {
      // Skip on error, don't fail the whole process
      logger.warn({ err }, `Warning: Could not install skill ${skill.name}:`);
    }
  }

  return {
    skills: installedSkills,
    agentsMirror,
    claudePreserved,
    agentsPreserved,
    legacyPreserved,
  };
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
  // A shared-store slot (#3352) lives under the GitNexus home, so its path
  // would be machine- and worktree-specific in committed docs; the runner goes
  // next to the checkout's store pointer instead.
  const runnerDir = storeRootOfCheckoutSlot(storagePath)
    ? path.join(repoPath, GITNEXUS_DIR)
    : storagePath;
  const runnerPath = path.relative(repoPath, path.join(runnerDir, 'run.cjs')).replace(/\\/g, '/');
  try {
    const runnerSrc = path.join(
      __dirname,
      '..',
      '..',
      'hooks',
      'claude',
      'resolve-analyze-cmd.cjs',
    );
    await fs.mkdir(runnerDir, { recursive: true });
    await fs.copyFile(runnerSrc, path.join(runnerDir, 'run.cjs'));
  } catch (err) {
    logger.warn(`Could not write GitNexus runner to ${runnerPath}: ${String(err)}`);
  }

  const render = (previousSection?: string) =>
    generateGitNexusContent(projectName, stats, {
      generatedSkills,
      previousSection,
      groupNames,
      noStats: options?.noStats,
      skipSkills: options?.skipSkills,
      runnerPath,
      defaultBranch: options?.defaultBranch ?? 'main',
      hasPdg: options?.hasPdg ?? false,
      hasSpringActuator: options?.hasSpringActuator ?? false,
    });
  const createdFiles: string[] = [];
  const instructionFiles = selectedInstructionFiles(options?.instructionFile);

  if (options?.skipAgentsMd) {
    for (const name of instructionFiles) {
      createdFiles.push(`${name} (skipped via --skip-agents-md)`);
    }
  } else {
    for (const name of instructionFiles) {
      const result = await upsertGitNexusSection(
        path.join(repoPath, name),
        render,
        projectName,
        stats,
        options?.noStats,
        options?.refreshCounts,
      );
      createdFiles.push(`${name} (${result})`);
    }
  }

  // Install standard skills directly under .claude/skills/ (unless --skip-skills)
  if (!options?.skipSkills) {
    const {
      skills: installedSkills,
      agentsMirror,
      claudePreserved,
      agentsPreserved,
      legacyPreserved,
    } = await installSkills(repoPath);
    if (installedSkills.length > 0) {
      createdFiles.push(
        formatSkillInstallLine(
          '.claude/skills/gitnexus-*/',
          installedSkills.length,
          claudePreserved,
          'skills',
          'preserved',
        ),
      );
      if (agentsMirror) {
        createdFiles.push(
          formatSkillInstallLine(
            '.agents/skills/gitnexus-*/',
            installedSkills.length,
            agentsPreserved,
            'skills mirrored for .agents',
            'preserved for .agents',
          ),
        );
      }
      if (legacyPreserved > 0) {
        createdFiles.push(
          `.claude/skills/gitnexus/<name>/ (legacy directories preserved: ${legacyPreserved})`,
        );
      }
    }
  } else {
    createdFiles.push('.claude/skills/gitnexus-*/ (skipped via --skip-skills)');
  }

  return { files: createdFiles };
}

/**
 * Refresh the regression-review target inside the GitNexus block of an
 * already-generated AGENTS.md / CLAUDE.md, in place (#1996 P2, #3509).
 *
 * The `alreadyUpToDate` analyze fast path returns before the normal
 * {@link generateAIContextFiles} call, so a changed `.gitnexusrc` defaultBranch
 * (or `--default-branch`) would otherwise not take effect until the next
 * re-index. This does a surgical line update that preserves the rest of the
 * block — including community-skill rows written by a prior `--skills` run —
 * rather than regenerating (which would drop those rows on a no-`--skills` run).
 *
 * Legacy blocks that passed the branch tip as `base_ref` are migrated to the
 * merge-base guidance at the same time. Best-effort: missing files, a
 * missing/blank block, or a block with no generated regression sentence are
 * silently skipped. Writes
 * only when the value actually changes, so a routine up-to-date run is a no-op.
 */
export async function refreshBaseRefLine(
  repoPath: string,
  defaultBranch: string,
  options?: Pick<AIContextOptions, 'skipAgentsMd' | 'instructionFile'>,
): Promise<{ files: string[] }> {
  if (options?.skipAgentsMd) return { files: [] };
  const updated: string[] = [];
  for (const name of selectedInstructionFiles(options?.instructionFile)) {
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
    // Preserve the runner emitted with the block. Its location follows the
    // configured storage path, so assuming `.gitnexus/run.cjs` would break the
    // CLI fallback when migrating guidance generated for an external store.
    const legacyRunner = block.match(
      /or `([^`\n]+?) detect-changes --scope compare --base-ref\b/,
    )?.[1];
    const mergeBaseGuidance = regressionReviewGuidance(defaultBranch, legacyRunner);
    let newBlock = block;
    if (!block.includes(mergeBaseGuidance) && block.includes('base_ref: "<merge-base SHA>"')) {
      newBlock = block.replace(
        /(?:(?:For (?:regression review of )?)?target branch "(?:[^"\\]|\\.)*": `git fetch origin -- [^`\n]+`; pass `git merge-base [^`\n]+ HEAD`'s SHA|Regression base: (?:PR GitHub `baseRefOid`\/`headRefOid`|exact PR base\/head commits from host metadata); target branch "(?:[^"\\]|\\.)*" via tracking remote\. Fetch both; pass merge-base SHA|For regression review, fetch target branch "(?:[^"\\]|\\.)*" from its remote; compute its merge base with the reviewed HEAD and pass that SHA) to `detect_changes\(\{scope: "compare", base_ref: "<merge-base SHA>"\}\)`(?: or `[^`\n]+? detect-changes --scope compare --base-ref "<merge-base SHA>" --repo \.\`)?\./,
        mergeBaseGuidance,
      );
    }
    if (newBlock === block) {
      // Migrate the legacy generated sentence.
      newBlock = block.replace(
        /For regression review: `detect_changes\(\{scope: "compare", base_ref: "(?:[^"\\]|\\.)*"\}\)`(?: or `[^`\n]+? detect-changes --scope compare --base-ref "(?:[^"\\]|\\.)*" --repo \.\`)?\./,
        mergeBaseGuidance,
      );
    }
    if (newBlock === block) {
      // Older compact blocks used this exact generated bullet rather than the
      // prose sentence. Keep the anchor narrow so user-authored compare calls
      // elsewhere in the managed block remain untouched.
      newBlock = block.replace(
        /- run detect_changes\(\{scope: "compare", base_ref: "(?:[^"\\]|\\.)*"\}\)(?=\s*(?:\n|$))/,
        `- ${mergeBaseGuidance}`,
      );
    }
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

/**
 * Refresh the volatile counts inside an already-generated block, in place
 * (#3618).
 *
 * The `alreadyUpToDate` analyze fast path returns before
 * {@link generateAIContextFiles}, so `--no-stats` had no effect on any repo that
 * was already indexed: the block kept its `(N symbols, N relationships, N
 * execution flows)` parenthetical however often the flag was passed. Like
 * {@link refreshBaseRefLine} this is a surgical edit, not a regeneration, so
 * community-skill rows written by a prior `--skills` run survive.
 *
 * Restore missing counts from `stats` when `--no-stats` is dropped (#1706).
 * An explicit analyze also updates existing figures, preserving custom spacing.
 * Best-effort: a missing file, missing/blank block or unmatched header line is
 * silently skipped, and nothing is written unless the line actually changes.
 *
 * shortcut: per-skill counts in an existing skills table are only dropped under
 * `--no-stats`, never restored — the fast path has no per-skill numbers, and
 * the next re-index regenerates them.
 */
export async function refreshStatsLine(
  repoPath: string,
  stats: RepoStats,
  options?: Pick<
    AIContextOptions,
    'noStats' | 'skipAgentsMd' | 'instructionFile' | 'refreshCounts'
  >,
): Promise<{ files: string[] }> {
  if (options?.skipAgentsMd) return { files: [] };
  const noStats = options?.noStats === true;
  // `alreadyUpToDate` hands us `meta.stats ?? {}`; restoring from that would
  // print zeros, so a repo whose index predates `stats` keeps its count-free
  // block until a real re-index.
  const counts =
    typeof stats.nodes === 'number'
      ? `${stats.nodes || 0} symbols, ${stats.edges || 0} relationships, ${stats.processes || 0} execution flows`
      : undefined;
  if (!noStats && counts === undefined) return { files: [] };
  const skillCountPattern = /^(\| Work in the .+? area) \(\d+ symbols\)(?=[ \t]*\|)/gm;
  const updated: string[] = [];
  for (const name of selectedInstructionFiles(options?.instructionFile)) {
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
    let newBlock = block.replace(
      STATS_LINE_PATTERN,
      (
        match,
        prefix: string,
        project: string,
        existingCounts: string | undefined,
        offset: number,
      ) => {
        // An unrecognized parenthetical may already contain counts. Do not
        // prepend a second tuple just because the optional capture missed it.
        if (existingCounts === undefined && /^\s*\(/.test(block.slice(offset + match.length))) {
          return match;
        }
        if (noStats) return `${prefix} ${project}`;
        if (existingCounts === undefined) return `${prefix} ${project} (${counts})`;
        if (!options?.refreshCounts) return match;
        const values = [stats.nodes, stats.edges ?? 0, stats.processes ?? 0];
        let i = 0;
        return `${prefix} ${project}${existingCounts.replace(/\d+/g, () => String(values[i++]))}`;
      },
    );
    if (noStats) newBlock = newBlock.replace(skillCountPattern, '$1');
    if (newBlock === block) continue;
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
