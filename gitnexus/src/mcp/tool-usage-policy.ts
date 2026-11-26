/**
 * Always Do / Never Do tool-usage policy.
 *
 * The MCP initialize `instructions` field and the AGENTS.md / CLAUDE.md block
 * both render this text. Per-index clauses stay parameters: one server covers
 * every repository, while `gitnexus analyze` knows the index it just built.
 */

/** Project-relative runner path the file block uses when analyze omits one. */
export const DEFAULT_POLICY_RUNNER_PATH = '.gitnexus/run.cjs';

/** CLI prefix matching {@link DEFAULT_POLICY_RUNNER_PATH}. */
export const DEFAULT_POLICY_RUNNER = `node ${DEFAULT_POLICY_RUNNER_PATH}`;

/**
 * Strip backticks from a branch name before it is embedded in a Markdown
 * inline-code span (#1996 tri-review P1). validateBranchName already rejects
 * backticks for CLI/config/auto-detect inputs; this is the last-line defense at
 * the generation sink so the embedding is provably safe regardless of caller.
 */
export function markdownSafeBranch(branch: string): string {
  return branch.replace(/`/g, '');
}

/** Regression-review sentence inside the detect_changes bullet (#243, #3509). */
export function regressionReviewGuidance(defaultBranch: string, runner?: string): string {
  const safeBranch = markdownSafeBranch(defaultBranch);
  const target = JSON.stringify(safeBranch);
  const cliFallback = runner
    ? ` or \`${runner} detect-changes --scope compare --base-ref "<merge-base SHA>" --repo .\``
    : '';
  return `For regression review, fetch target branch ${target} from its remote; compute its merge base with the reviewed HEAD and pass that SHA to \`detect_changes({scope: "compare", base_ref: "<merge-base SHA>"})\`${cliFallback}.`;
}

export interface ToolUsagePolicyOptions {
  /** CLI prefix, for example `node .gitnexus/run.cjs`. */
  runner: string;
  defaultBranch: string;
  /** Index was built with `--pdg`. Gates the PDG bullets. */
  hasPdg?: boolean;
  /** Index includes opt-in Spring Actuator runtime evidence. */
  hasSpringActuator?: boolean;
}

/**
 * Always Do / Never Do markdown. Callers that pass the same options as
 * `generateGitNexusContent` get the exact section that function embeds.
 */
export function renderToolUsagePolicy(opts: ToolUsagePolicyOptions): string {
  const { runner, defaultBranch, hasPdg = false, hasSpringActuator = false } = opts;
  return `## Always Do

- **MUST run impact before editing.** Use \`impact({target: "symbolName", direction: "upstream"})\` or \`${runner} impact "symbolName" --direction upstream --repo .\`; report callers/processes/risk. Never substitute grep for graph analysis.${
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

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read \`UNKNOWN\` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use \`rename\` with \`dry_run: true\`, review semantic spans and coverage, then apply with \`dry_run: false\` and its \`plan_token\`.
- NEVER commit before MCP/CLI graph change analysis.`;
}

const SERVER_INSTRUCTIONS_PREAMBLE = 'Follow this GitNexus tool-usage policy.';

/**
 * `instructions` for the MCP initialize result.
 *
 * Baseline policy only: {@link DEFAULT_POLICY_RUNNER}, target branch `main`,
 * and no per-index PDG or Spring Actuator lines. The file block passes the
 * index's own options to {@link renderToolUsagePolicy}.
 */
export function mcpServerInstructions(): string {
  return `${SERVER_INSTRUCTIONS_PREAMBLE}\n\n${renderToolUsagePolicy({
    runner: DEFAULT_POLICY_RUNNER,
    defaultBranch: 'main',
  })}`;
}
