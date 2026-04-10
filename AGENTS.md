<!-- version: 1.2.0 -->
<!--
  Metadata: version, last reviewed, scope, model policy, reference docs, changelog.
  Last updated: 2026-03-22
-->

Last reviewed: 2026-03-24

**Project:** GitNexus · **Environment:** dev · **Maintainer:** repository maintainers (see GitHub)

This file uses a standard agent header (version, scope, model policy, reference docs, changelog), adapted for this **TypeScript/JavaScript monorepo**.

## Scope

| | |
|--|--|
| **Reads** | Repository tree as needed for the task: `gitnexus/`, `gitnexus-web/`, `eval/`, plugin packages, `.github/`, `.gitnexus/` when present, and docs. |
| **Writes** | Only paths required for the requested change; keep diffs minimal. Update lockfiles when dependencies change. |
| **Executes** | `npm`, `npx`, `node` under `gitnexus/` and `gitnexus-web/`; `uv run` for Python under `eval/` when applicable; shell utilities for documented CI/dev workflows. |
| **Off-limits** | User secrets (e.g. real `.env`), production deployment credentials, unrelated repositories, destructive git history operations without explicit human confirmation. |

## Model Configuration

- **Primary:** Pin in **Cursor** (Settings → model). Use a **named** model (e.g. GPT-5.2, Claude Sonnet 4.x). Avoid relying on **Auto** when reproducibility or audit trail matters.
- **Fallback:** As configured in Cursor or your organization (do not encode `latest` or wildcards in automation configs).
- **Notes:** The open-source GitNexus CLI indexer does not call an LLM. Optional Nexus AI in the web UI uses end-user provider keys and models.

## Execution Sequence (complex tasks)

Long sessions dilute instructions. For **multi-step** work, state up front:

1. Which rules in this file and **[GUARDRAILS.md](GUARDRAILS.md)** apply (and any relevant Signs).
2. Current **Scope** boundaries (Reads / Writes / Off-limits).
3. Which **validation commands** you will run (e.g. `cd gitnexus && npm test`, `npx tsc --noEmit`).

On very long threads, the human may add *“Remember: apply all AGENTS.md rules”* to re-weight rule tokens against context dilution.

## Claude Code hooks

Hooks enforce gates that prompts cannot. In **Claude Code**, **PreToolUse** hooks can block tools such as `git_commit` until checks pass. Adapt to this repo: e.g. `cd gitnexus && npm test` before commit.

## Context budget (Cursor / standards)

Generic “core standards” playbooks are often long and stack-specific. For this monorepo, commands and gotchas live under **Cursor Cloud specific instructions** below and in **[CONTRIBUTING.md](CONTRIBUTING.md)**. If always-on rules grow, split domain rules into **`.cursor/rules/*.mdc`** (globs). **Cursor:** project-wide rules live in **`.cursor/index.mdc`** (YAML frontmatter with `alwaysApply: true`). **Claude Code:** optionally load a **`STANDARDS.md`** only when needed (e.g. *“When writing new code, read STANDARDS.md”*) to save context.

## Reference Documentation

- **This repository:** **[ARCHITECTURE.md](ARCHITECTURE.md)**, **[CONTRIBUTING.md](CONTRIBUTING.md)**, **[GUARDRAILS.md](GUARDRAILS.md)**.
- **Cursor:** `.cursor/index.mdc` (always-on rules); optional `.cursor/rules/*.mdc` (glob-scoped). Legacy `.cursorrules` is deprecated — see `.cursor/index.mdc`.
- **Optional local files:** `NOTES.md` (short vendor-neutral project snapshot). For handoffs, keep notes local (e.g., a scratch file outside the repo) rather than committing `HANDOFF.md`.
- **GitNexus:** skills under `.claude/skills/gitnexus/`; machine-oriented rules in the `gitnexus:start` … `gitnexus:end` block below.

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-03-24 | 1.2.0 | Fixed gitnexus:start block duplication (was inlined in Reference Docs bullet). |
| 2026-03-23 | 1.1.0 | Updated agent instructions (sections, references, Cursor layout). |
| 2026-03-22 | 1.0.0 | Added structured agent header and changelog. |

---

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **GitNexus** (3883 symbols, 9861 relationships, 225 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Cursor Cloud specific instructions

### Repository structure

This is a monorepo with two main products and supporting config packages:

| Component | Path | Purpose |
|-----------|------|---------|
| **GitNexus CLI/Core** | `gitnexus/` | Main product — TypeScript CLI, indexing pipeline, MCP server. Published to npm. |
| **GitNexus Web UI** | `gitnexus-web/` | React/Vite browser app — graph explorer + AI chat. Runs entirely in WASM. |
| Claude Plugin | `gitnexus-claude-plugin/` | Static config for Claude marketplace (no build). |
| Cursor Integration | `gitnexus-cursor-integration/` | Static config for Cursor editor (no build). |
| SWE-bench Eval | `eval/` | Python evaluation harness (optional; needs Docker + LLM API keys). |

### Running services

- **CLI/Core**: `cd gitnexus && npm run dev` (tsx watch mode) or `npm run build && node dist/cli/index.js <command>`
- **Web UI**: `cd gitnexus-web && npm run dev` (Vite on port 5173)
- **Backend mode**: `cd <indexed-repo> && node /workspace/gitnexus/dist/cli/index.js serve` (HTTP API on port 3741 by default)

### Testing

**CLI / Core (`gitnexus/`)**
- **Unit tests**: `cd gitnexus && npm test` (vitest, ~2000 tests)
- **Integration tests**: `cd gitnexus && npm run test:integration` (vitest, ~1850 tests). Two LadybugDB file-locking tests (`lbug-core-adapter`, `search-core`) may fail in containerized environments due to `/tmp` locking limitations — this is a known environment issue, not a code bug.
- **TypeScript check**: `cd gitnexus && npx tsc --noEmit`

**Web UI (`gitnexus-web/`)**
- **Unit tests**: `cd gitnexus-web && npm test` (vitest, ~200 tests)
- **E2E tests**: `cd gitnexus-web && E2E=1 npx playwright test` (Playwright, 5 tests — requires `gitnexus serve` + `npm run dev` running)
- **TypeScript check**: `cd gitnexus-web && npx tsc -b --noEmit`

No separate lint command is configured; TypeScript strict checking serves as the primary static analysis.

### Gotchas

- `npm install` in `gitnexus/` triggers `prepare` (builds via `tsc`) and `postinstall` (patches tree-sitter-swift). Native tree-sitter bindings require `python3`, `make`, and `g++` to be present.
- `tree-sitter-kotlin` and `tree-sitter-swift` are optional dependencies — install warnings for these are expected and non-blocking.
- The Web UI uses `vite-plugin-wasm` and requires `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers for `SharedArrayBuffer` (handled automatically by Vite dev server).
- There is no ESLint/Prettier configuration in this repo.
