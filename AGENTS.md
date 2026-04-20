<!-- version: 1.4.0 -->
<!-- Last updated: 2026-04-16 -->

Last reviewed: 2026-04-16

**Project:** GitNexus · **Environment:** dev · **Maintainer:** repository maintainers (see GitHub)

## Scope

| Boundary | Rule |
|----------|------|
| **Reads** | `gitnexus/`, `gitnexus-web/`, `eval/`, plugin packages, `.github/`, `.gitnexus/`, docs. |
| **Writes** | Only paths required for the change; keep diffs minimal. Update lockfiles when deps change. |
| **Executes** | `npm`, `npx`, `node` under `gitnexus/` and `gitnexus-web/`; `uv run` for Python under `eval/`; documented CI/dev workflows. |
| **Off-limits** | Real `.env` / secrets, production credentials, unrelated repos, destructive git ops without confirmation. |

## Model Configuration

- **Primary:** Use a named model (e.g. Claude Sonnet 4.x). Avoid `Auto` or unversioned `latest` when reproducibility matters.
- **Notes:** The GitNexus CLI indexer does not call an LLM.

## Execution Sequence (complex tasks)

For multi-step work, state up front:
1. Which rules in this file and **[GUARDRAILS.md](GUARDRAILS.md)** apply (and any relevant Signs).
2. Current **Scope** boundaries.
3. Which **validation commands** you will run (`cd gitnexus && npm test`, `npx tsc --noEmit`).

On long threads, *"Remember: apply all AGENTS.md rules"* re-weights these instructions against context dilution.

## Claude Code hooks

**PreToolUse** hooks can block tools (e.g. `git_commit`) until checks pass. Adapt to this repo: `cd gitnexus && npm test` before commit.

## Context budget

Commands and gotchas live under **Repo reference** below and in **[CONTRIBUTING.md](CONTRIBUTING.md)**. If always-on rules grow, split into **`.cursor/rules/*.mdc`** (globs). **Cursor:** project-wide rules in `.cursor/index.mdc`. **Claude Code:** load `STANDARDS.md` only when needed.

## Reference docs

- **[ARCHITECTURE.md](ARCHITECTURE.md)**, **[CONTRIBUTING.md](CONTRIBUTING.md)**, **[GUARDRAILS.md](GUARDRAILS.md)**
- **Call-resolution DAG:** See ARCHITECTURE.md § Call-Resolution DAG. Typed 6-stage DAG inside the `parse` phase; language-specific behavior behind `inferImplicitReceiver` / `selectDispatch` hooks on `LanguageProvider`. Shared code in `gitnexus/src/core/ingestion/` must not name languages. Types: `gitnexus/src/core/ingestion/call-types.ts`.
- **Cursor:** `.cursor/index.mdc` (always-on); `.cursor/rules/*.mdc` (glob-scoped). Legacy `.cursorrules` deprecated.
- **GitNexus:** skills in `.claude/skills/gitnexus/`; MCP rules in `gitnexus:start` block below.

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-04-19 | 1.5.0 | Cross-repo impact (#794): `impact`/`query`/`context` accept `repo: "@<group>"` + `service`. Removed `group_query`/`group_contracts`/`group_status` MCP tools; added `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status` resources. |
| 2026-04-16 | 1.4.0 | Fixed: web UI description, pre-commit behavior, MCP tools (7->16), added gitnexus-shared, removed stale vite-plugin-wasm gotcha. |
| 2026-04-13 | 1.3.0 | Updated GitNexus index stats after DAG refactor. |
| 2026-03-24 | 1.2.0 | Fixed gitnexus:start block duplication. |
| 2026-03-23 | 1.1.0 | Updated agent instructions, references, Cursor layout. |
| 2026-03-22 | 1.0.0 | Initial structured header and changelog. |

---

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

Indexed as **GitNexus** (4325 symbols, 10556 relationships, 300 execution flows). Use MCP tools to understand code, assess impact, and navigate safely.

> If any tool warns the index is stale, run `npx gitnexus analyze` first.

## Always Do

- **MUST run impact analysis before editing any symbol.** `gitnexus_impact({target: "symbolName", direction: "upstream"})` — report blast radius to the user.
- **MUST run `gitnexus_detect_changes()` before committing** — verify only expected symbols and flows are affected.
- **MUST warn the user** if impact returns HIGH or CRITICAL risk.
- Explore unfamiliar code with `gitnexus_query({query: "concept"})` (process-grouped, ranked) instead of grepping.
- Full context on a symbol: `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find related execution flows
2. `gitnexus_context({name: "<suspect function>"})` — callers, callees, process participation
3. `READ gitnexus://repo/GitNexus/process/{processName}` — trace flow step by step
4. Regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})`

## When Refactoring

- **Rename:** `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Graph edits are safe; text_search edits need manual review.
- **Extract/Split:** `gitnexus_context` (incoming/outgoing refs) then `gitnexus_impact` (upstream callers) before moving code.
- **After any refactor:** `gitnexus_detect_changes({scope: "all"})` to verify scope.

## Never Do

- Edit a symbol without running `gitnexus_impact` first.
- Ignore HIGH/CRITICAL risk warnings.
- Rename with find-and-replace — use `gitnexus_rename`.
- Commit without `gitnexus_detect_changes()`.
- Add language-specific behavior to shared ingestion code (`gitnexus/src/core/ingestion/`) — use a `LanguageProvider` hook. Seeing `provider.mroStrategy === 'xxx'` or an import from `languages/xxx.ts` in shared code means stop and add a hook.

## Tools Quick Reference

| Tool | When to use | Example |
|------|-------------|---------|
| `list_repos` | Discover indexed repos | `gitnexus_list_repos({})` |
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |
| `api_impact` | Pre-change API route impact | `gitnexus_api_impact({route: "/api/users", method: "GET"})` |
| `route_map` | Route → handler → consumer map | `gitnexus_route_map({})` |
| `tool_map` | MCP/RPC tool definitions | `gitnexus_tool_map({})` |
| `shape_check` | Response shape vs consumer access | `gitnexus_shape_check({route: "/api/users"})` |
| `group_list` | List repo groups | `gitnexus_group_list({})` |
| `group_sync` | Rebuild group Contract Registry | `gitnexus_group_sync({name: "myGroup"})` |
| `query` (group mode) | Cross-repo search in a group (RRF-merged) | `gitnexus_query({repo: "@myGroup", query: "auth"})` |
| `context` (group mode) | 360° view across all member repos | `gitnexus_context({repo: "@myGroup", name: "validateUser"})` |
| `impact` (group mode) | Cross-repo blast radius via Contract Bridge | `gitnexus_impact({repo: "@myGroup", target: "X", direction: "upstream"})` |

> Group mode: pass `repo: "@<groupName>"` to fan out across all member repos, or `repo: "@<groupName>/<memberPath>"` to target a single member (path keys from `group.yaml`). Optional `service: "<monorepo/path>"` filters by service root. Group-level state (contracts, staleness) lives in the resources table below — there are **no** `group_query` / `group_context` / `group_impact` / `group_contracts` / `group_status` MCP tools.
>
> For a full walkthrough of setting up a group across multiple repos that communicate over gRPC, see [docs/guides/microservices-grpc.md](docs/guides/microservices-grpc.md).

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/GitNexus/context` | Codebase overview, index freshness |
| `gitnexus://repo/GitNexus/clusters` | All functional areas |
| `gitnexus://repo/GitNexus/processes` | All execution flows |
| `gitnexus://repo/GitNexus/process/{name}` | Step-by-step execution trace |
| `gitnexus://group/{name}/contracts` | Group Contract Registry (provider/consumer rows + cross-links) |
| `gitnexus://group/{name}/status` | Per-member index + Contract Registry staleness report |

## Self-Check Before Finishing

1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL warnings were ignored
3. `gitnexus_detect_changes()` confirms expected scope
4. All d=1 dependents were updated

## Keeping the Index Fresh

```bash
npx gitnexus analyze              # basic refresh
npx gitnexus analyze --embeddings # preserve embeddings
```

Check `.gitnexus/meta.json` `stats.embeddings` (0 = none). Running without `--embeddings` deletes existing vectors.

> Claude Code: PostToolUse hook handles this after `git commit` and `git merge`.

## CLI Skills

| Task | Skill file |
|------|-----------|
| Architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Debugging / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Refactoring | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools/resources/schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| CLI commands (index, status, clean, wiki) | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Repo reference

### Packages

| Package | Path | Purpose |
|---------|------|---------|
| **CLI/Core** | `gitnexus/` | TypeScript CLI, indexing pipeline, MCP server. Published to npm. |
| **Web UI** | `gitnexus-web/` | React/Vite thin client. All queries via `gitnexus serve` HTTP API. |
| **Shared** | `gitnexus-shared/` | Shared TypeScript types and constants. |
| Claude Plugin | `gitnexus-claude-plugin/` | Static config for Claude marketplace. |
| Cursor Integration | `gitnexus-cursor-integration/` | Static config for Cursor editor. |
| Eval | `eval/` | Python evaluation harness (Docker + LLM API keys). |

### Running services

```bash
cd gitnexus && npm run dev                 # CLI: tsx watch mode
cd gitnexus-web && npm run dev             # Web UI: Vite on port 5173
npx gitnexus serve                         # HTTP API on port 4747 (from any indexed repo)
```

### Testing

**CLI / Core (`gitnexus/`)**
- `npm test` — full vitest suite (~2000 tests)
- `npm run test:unit` — unit tests only
- `npm run test:integration` — integration (~1850 tests). LadybugDB file-locking tests may fail in containers (known env issue).
- `npx tsc --noEmit` — typecheck

**Web UI (`gitnexus-web/`)**
- `npm test` — vitest (~200 tests)
- `npm run test:e2e` — Playwright (7 spec files; requires `gitnexus serve` + `npm run dev`)
- `npx tsc -b --noEmit` — typecheck

**Pre-commit hook** (`.husky/pre-commit`): formatting (prettier via lint-staged) + typecheck for staged packages. Tests do **not** run in pre-commit — CI only.

### Gotchas

- `npm install` in `gitnexus/` triggers `prepare` (builds via `tsc`) and `postinstall` (patches tree-sitter-swift, builds tree-sitter-proto). Native bindings need `python3`, `make`, `g++`.
- `tree-sitter-kotlin` and `tree-sitter-swift` are optional — install warnings expected.
- ESLint configured via `eslint.config.mjs` (TS, React Hooks, unused-imports). No `npm run lint` script; use `npx eslint .`. Prettier runs via lint-staged. CI checks both in `ci-quality.yml`.
