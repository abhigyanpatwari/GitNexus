<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **GitNexus** (1747 symbols, 4569 relationships, 130 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/GitNexus/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/GitNexus/context` | Codebase overview, check index freshness |
| `gitnexus://repo/GitNexus/clusters` | All functional areas |
| `gitnexus://repo/GitNexus/processes` | All execution flows |
| `gitnexus://repo/GitNexus/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |
| Work in the Ingestion area (135 symbols) | `.claude/skills/generated/ingestion/SKILL.md` |
| Work in the Workers area (70 symbols) | `.claude/skills/generated/workers/SKILL.md` |
| Work in the Cli area (63 symbols) | `.claude/skills/generated/cli/SKILL.md` |
| Work in the Kuzu area (52 symbols) | `.claude/skills/generated/kuzu/SKILL.md` |
| Work in the Wiki area (52 symbols) | `.claude/skills/generated/wiki/SKILL.md` |
| Work in the Embeddings area (48 symbols) | `.claude/skills/generated/embeddings/SKILL.md` |
| Work in the Components area (42 symbols) | `.claude/skills/generated/components/SKILL.md` |
| Work in the Local area (36 symbols) | `.claude/skills/generated/local/SKILL.md` |
| Work in the Storage area (36 symbols) | `.claude/skills/generated/storage/SKILL.md` |
| Work in the Services area (35 symbols) | `.claude/skills/generated/services/SKILL.md` |
| Work in the Mcp area (32 symbols) | `.claude/skills/generated/mcp/SKILL.md` |
| Work in the Llm area (30 symbols) | `.claude/skills/generated/llm/SKILL.md` |
| Work in the Eval area (18 symbols) | `.claude/skills/generated/eval/SKILL.md` |
| Work in the Bridge area (15 symbols) | `.claude/skills/generated/bridge/SKILL.md` |
| Work in the Hooks area (14 symbols) | `.claude/skills/generated/hooks/SKILL.md` |
| Work in the Search area (11 symbols) | `.claude/skills/generated/search/SKILL.md` |
| Work in the Environments area (11 symbols) | `.claude/skills/generated/environments/SKILL.md` |
| Work in the Analysis area (10 symbols) | `.claude/skills/generated/analysis/SKILL.md` |
| Work in the Agents area (9 symbols) | `.claude/skills/generated/agents/SKILL.md` |
| Work in the Graph area (6 symbols) | `.claude/skills/generated/graph/SKILL.md` |

<!-- gitnexus:end -->
