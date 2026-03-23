<!-- version: 1.1.0 -->
<!--
  Metadata: version, last reviewed, scope, model policy, reference docs, changelog.
  Last updated: 2026-03-22
-->

Last reviewed: 2026-03-22

**Project:** GitNexus · **Environment:** dev · **Maintainer:** repository maintainers (see GitHub)

Follow **AGENTS.md** for the canonical rules; this file adds Claude Code–specific deltas. Cursor-specific notes live only in `AGENTS.md`.

## Scope

| | |
|--|--|
| **Reads** | Repository tree as needed for the task: `gitnexus/`, `gitnexus-web/`, `eval/`, plugin packages, `.github/`, `.gitnexus/` when present, and docs. |
| **Writes** | Only paths required for the requested change; keep diffs minimal. Update lockfiles when dependencies change. |
| **Executes** | `npm`, `npx`, `node` under `gitnexus/` and `gitnexus-web/`; `uv run` for Python under `eval/` when applicable; shell utilities for documented CI/dev workflows. |
| **Off-limits** | User secrets (e.g. real `.env`), production deployment credentials, unrelated repositories, destructive git history operations without explicit human confirmation. |

(Cursor-specific workflow notes appear only in [AGENTS.md](AGENTS.md).)

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
- **GitNexus:** `.claude/skills/gitnexus/`; MCP and indexed-repo rules live only in [AGENTS.md](AGENTS.md) (`gitnexus:start` … `gitnexus:end`). See **GitNexus rules** below.

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-03-23 | 1.1.0 | Updated agent instructions to match AGENTS.md. |
| 2026-03-22 | 1.0.0 | Added structured header and changelog. |

---

## GitNexus rules

For all GitNexus MCP guidance, impact-analysis requirements, and commands, use [AGENTS.md](AGENTS.md) as the single source of truth. That file carries the `gitnexus:start` block, current commands, and index-hygiene notes.
