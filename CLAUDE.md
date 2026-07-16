<!-- version: 1.3.0 -->
<!--
  Metadata: version, last reviewed, scope, model policy, reference docs, changelog.
  Last updated: 2026-03-22
-->

Last reviewed: 2026-04-13

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

## Claude Code hooks

Prefer **PreToolUse** hooks for hard gates (e.g. tests before `git_commit`). Adapt hook commands to `gitnexus/` npm scripts.

## Context budget

If always-on instructions grow, load deep conventions via conditional reads (e.g. *“When writing new code, read STANDARDS.md”*) instead of pasting long blocks here. In Cursor, prefer `.cursor/index.mdc` plus optional `.cursor/rules/*.mdc` globs (see [AGENTS.md](AGENTS.md) § Context budget).

## Reference Documentation

- **This repository:** [AGENTS.md](AGENTS.md) (Cursor + monorepo notes), [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), [GUARDRAILS.md](GUARDRAILS.md).
- **Call & inheritance resolution:** See ARCHITECTURE.md § Scope-Resolution Pipeline. Shared pipeline code in `gitnexus/src/core/ingestion/` must not name languages — use `LanguageProvider` / `ScopeResolver` hooks instead (see AGENTS.md). (The legacy call-resolution DAG was removed in #942.)
- **GitNexus:** standard skills in `.claude/skills/gitnexus-*/`; MCP and indexed-repo rules live only in [AGENTS.md](AGENTS.md) (`gitnexus:start` … `gitnexus:end`). See **GitNexus rules** below.

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-04-13 | 1.3.0 | Updated GitNexus index stats after DAG refactor. |
| 2026-03-24 | 1.2.0 | Removed duplicated gitnexus:start block and scope table; replaced with pointers to AGENTS.md. |
| 2026-03-23 | 1.1.0 | Updated agent instructions to match AGENTS.md. |
| 2026-03-22 | 1.0.0 | Added structured header and changelog. |

---

## GitNexus rules

See the `<!-- gitnexus:start --> … <!-- gitnexus:end -->` block in **[AGENTS.md](AGENTS.md)** for the canonical MCP tools, impact analysis rules, and index instructions.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **GitNexus** (26675 symbols, 35395 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/GitNexus/context` | Codebase overview, check index freshness |
| `gitnexus://repo/GitNexus/clusters` | All functional areas |
| `gitnexus://repo/GitNexus/processes` | All execution flows |
| `gitnexus://repo/GitNexus/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |
| Work in the Ingestion area (239 symbols) | `.claude/skills/gitnexus-area-ingestion/SKILL.md` |
| Work in the Extractors area (135 symbols) | `.claude/skills/gitnexus-area-extractors/SKILL.md` |
| Work in the Components area (112 symbols) | `.claude/skills/gitnexus-area-components/SKILL.md` |
| Work in the Lbug area (96 symbols) | `.claude/skills/gitnexus-area-lbug/SKILL.md` |
| Work in the Group area (94 symbols) | `.claude/skills/gitnexus-area-group/SKILL.md` |
| Work in the Cli area (92 symbols) | `.claude/skills/gitnexus-area-cli/SKILL.md` |
| Work in the Configs area (92 symbols) | `.claude/skills/gitnexus-area-configs/SKILL.md` |
| Work in the Type-extractors area (90 symbols) | `.claude/skills/gitnexus-area-type-extractors/SKILL.md` |
| Work in the Hooks area (88 symbols) | `.claude/skills/gitnexus-area-hooks/SKILL.md` |
| Work in the Unit area (80 symbols) | `.claude/skills/gitnexus-area-unit/SKILL.md` |
| Work in the Cpp area (73 symbols) | `.claude/skills/gitnexus-area-cpp/SKILL.md` |
| Work in the Scope-resolution area (72 symbols) | `.claude/skills/gitnexus-area-scope-resolution/SKILL.md` |
| Work in the Server area (66 symbols) | `.claude/skills/gitnexus-area-server/SKILL.md` |
| Work in the Local area (61 symbols) | `.claude/skills/gitnexus-area-local/SKILL.md` |
| Work in the Wiki area (60 symbols) | `.claude/skills/gitnexus-area-wiki/SKILL.md` |
| Work in the Workers area (57 symbols) | `.claude/skills/gitnexus-area-workers/SKILL.md` |
| Work in the Embeddings area (56 symbols) | `.claude/skills/gitnexus-area-embeddings/SKILL.md` |
| Work in the Typescript area (53 symbols) | `.claude/skills/gitnexus-area-typescript/SKILL.md` |
| Work in the Storage area (51 symbols) | `.claude/skills/gitnexus-area-storage/SKILL.md` |
| Work in the Php area (48 symbols) | `.claude/skills/gitnexus-area-php/SKILL.md` |

<!-- gitnexus:end -->
