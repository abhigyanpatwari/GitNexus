<!-- version: 1.4.0 -->
<!--
  Metadata: version, last reviewed, scope, model policy, reference docs, changelog.
  Last updated: 2026-05-12
-->

Last reviewed: 2026-05-12

**Project:** GitNexus · **Environment:** dev · **Maintainer:** repository maintainers (see GitHub)

Follow **AGENTS.md** for the canonical rules; this file adds Claude Code–specific deltas. Cursor-specific notes live only in `AGENTS.md`.

## Scope

See the **Scope** table in [AGENTS.md](AGENTS.md) for read/write/execute/off-limits boundaries. Cursor-specific workflow notes also live only in AGENTS.md.

## Model Configuration

- **Primary:** Pin per **Claude Code** / Anthropic org policy (explicit model id). Do not rely on an unversioned `latest` alias for governed workflows.
- **Fallback:** As configured in Claude Code (organization default or user override).
- **Notes:** The GitNexus CLI analyzer does not call an LLM.

## Execution Sequence (complex tasks)

Same discipline as [AGENTS.md](AGENTS.md): before large multi-step work, state which **AGENTS.md** / **GUARDRAILS.md** rules apply, current **Scope**, and planned validation commands (`npm test`, `tsc`, etc.). When pausing, summarize progress in the chat or a **local** scratch file (do not add `HANDOFF.md` to the repo), then `/clear` and resume with that summary.

## Claude Code Hooks

`.claude/settings.json` wires two automated behaviors via `.claude/hooks/gitnexus-hook.js`:

- **PreToolUse** (`Grep | Glob | Bash`) — before each search, runs `gitnexus augment` with the search pattern and injects matching graph context into the agent's tool result. No-ops silently when the index is absent.
- **PostToolUse** (`Bash`) — after `git commit / merge / rebase / cherry-pick / pull`, compares `HEAD` against the last-indexed commit in `.gitnexus/meta.json` and notifies the agent to run `npx gitnexus analyze` if the index is stale. Does not run `analyze` itself to avoid blocking the agent.

> Windows note: `SessionStart` hooks are broken on Windows (Claude Code bug #23576). Session context is injected via `CLAUDE.md` and skills instead.

## Context budget

If always-on instructions grow, load deep conventions via conditional reads (e.g. *"When writing new code, read STANDARDS.md"*) instead of pasting long blocks here. In Cursor, prefer `.cursor/index.mdc` plus optional `.cursor/rules/*.mdc` globs (see [AGENTS.md](AGENTS.md) § Context budget).

## Reference Documentation

- **This repository:** [AGENTS.md](AGENTS.md) (Cursor + monorepo notes), [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), [GUARDRAILS.md](GUARDRAILS.md).
- **Call-resolution DAG:** See ARCHITECTURE.md § Call-Resolution DAG. Shared pipeline code in `gitnexus/src/core/ingestion/` must not name languages — use `LanguageProvider` hooks instead (see AGENTS.md).
- **GitNexus MCP:** `.claude/skills/gitnexus/` — skill files below. Full tool/resource reference and rules live in [AGENTS.md](AGENTS.md) (`gitnexus:start` … `gitnexus:end`).

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-05-12 | 1.4.0 | Added `.claude/settings.json` (hooks + MCP permissions), `.claude/hooks/gitnexus-hook.js`, and inline GitNexus rules for Claude Code full support. |
| 2026-04-13 | 1.3.0 | Updated GitNexus index stats after DAG refactor. |
| 2026-03-24 | 1.2.0 | Removed duplicated gitnexus:start block and scope table; replaced with pointers to AGENTS.md. |
| 2026-03-23 | 1.1.0 | Updated agent instructions to match AGENTS.md. |
| 2026-03-22 | 1.0.0 | Added structured header and changelog. |

---

<!-- gitnexus:start -->
## GitNexus rules

> Full canonical rules (including monorepo and Cursor-specific notes) are in [AGENTS.md](AGENTS.md). The section below is the Claude Code–specific subset.

### Always Do

- **MUST run impact analysis before editing any symbol.** Run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** — verify only expected symbols and execution flows are affected.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding.
- Explore unfamiliar code with `gitnexus_query({query: "concept"})` instead of grepping — returns process-grouped results ranked by relevance.
- Full context on a symbol: `gitnexus_context({name: "symbolName"})` — callers, callees, process participation.

### Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.
- NEVER add language-specific behavior to shared ingestion code (`gitnexus/src/core/ingestion/`) — use a `LanguageProvider` hook instead.

### Skills

| Task | Skill file |
|------|-----------|
| Architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| PR review with graph context | `.claude/skills/gitnexus/gitnexus-pr-review/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| CLI commands (index, status, clean, wiki) | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

### Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/GitNexus/context` | Codebase overview, index freshness |
| `gitnexus://repo/GitNexus/clusters` | All functional areas |
| `gitnexus://repo/GitNexus/processes` | All execution flows |
| `gitnexus://repo/GitNexus/process/{name}` | Step-by-step execution trace |

> If any tool warns the index is stale, run `npx gitnexus analyze` in the terminal first.
<!-- gitnexus:end -->
