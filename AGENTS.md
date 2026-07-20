<!-- version: 1.14.0 -->
<!-- Last updated: 2026-07-16 -->

Last reviewed: 2026-07-16

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
- **Call & inheritance resolution (RFC #909 Ring 3):** See ARCHITECTURE.md § Scope-Resolution Pipeline. All languages resolve calls and inheritance through the scope-resolution pipeline (`Registry.lookup`, `preEmitInheritanceEdges`, `emitHeritageEdges`, `buildMro` → `MethodDispatchIndex`). **Shared code in `gitnexus/src/core/ingestion/` must not name languages** — plug language behavior in via `LanguageProvider` / `ScopeResolver` hooks. A language plugs in by implementing `ScopeResolver` (`scope-resolution/contract/scope-resolver.ts`) and registering it in `SCOPE_RESOLVERS`. (The legacy call-resolution DAG + `@heritage` capture path were removed in RING4-1 #942.)
- **Cursor:** `.cursor/index.mdc` (always-on); `.cursor/rules/*.mdc` (glob-scoped). Legacy `.cursorrules` deprecated.
- **GitNexus:** standard skills in `.claude/skills/gitnexus-*/`; MCP rules in `gitnexus:start` block below.

## PR Swarm Review (cross-CLI)

To run a production-readiness review of a GitNexus pull request from **any** AI CLI, follow
the canonical, CLI-neutral spec **[`pr-swarm-review/orchestration.md`](pr-swarm-review/orchestration.md)**
(seven read-only review personas under `pr-swarm-review/personas/`). It defines two
execution modes with the same output contract: **Swarm mode** (parallel subagents, e.g.
Claude Code) and **Solo mode** (one agent runs all lanes sequentially — Codex, Gemini,
Cursor, Copilot, or any agent reading this file). Per-CLI entrypoints are thin wrappers
listed in [`pr-swarm-review/README.md`](pr-swarm-review/README.md); edit review logic only
in the canonical files, never in the wrappers. The review is read-only — it never edits,
commits, or posts.

## Engineering planning & execution (`/gitnexus-plan` · `/gitnexus-work` · `/gitnexus-review` · `/gitnexus-lfg`)

Four canonical, CLI-neutral skill specs under `.claude/skills/` (Claude Code invokes
them as slash commands; Codex or any other agent reading this file should read the
named SKILL.md and follow it directly — user-level Codex prompts are documented in the
plan/work/lfg skill READMEs):

- **`gitnexus-plan/SKILL.md`** — deep, implementation-ready plan for a code change:
  GitNexus graph intelligence for navigation, statement-level PDG slices for behavioral
  constraints, targeted source reads for verification. Output lands in `docs/plans/`
  with a reusable implementation context pack (section 11). Planning-only — it never
  edits code (index freshness refreshes via `analyze --index-only` are the one
  permitted state change). Interactive runs ask up front how deep to go
  (quick / standard / deep); Deepen mode strengthens an existing plan in place.
- **`gitnexus-work/SKILL.md`** — executes a gitnexus-plan as verified atomic commits:
  drift-checks the plan's evidence pin against HEAD, `impact` before every symbol
  edit, tests from the plan's scenarios, `detect_changes` before every commit.
- **`gitnexus-review/SKILL.md`** — read-only GitNexus review of a PR URL/number,
  branch or commit range, or local staged/unstaged/untracked changes. It pins exact
  SHAs, aligns the graph and checkout, runs a PDG-backed taint pass on trust-boundary
  diffs, scales to per-domain expert lenses from the graph's clusters (dispatched as
  parallel swarm lanes — `ci-personas/` — when the CI review agent runs it), and
  reports evidence-backed findings.
- **`gitnexus-lfg/SKILL.md`** — pipeline orchestrator: plan (depth asked up front) →
  blocking user gate (proceed or stop) → work → `gitnexus-review`.

The family ships with the npm package (`gitnexus/skills/`, installed to editor targets
by `gitnexus setup`) and the Claude Code plugin; review also has a standalone Cursor
mirror. `gitnexus/test/unit/shipped-skills-sync.test.ts` guards the copies. Token savings of the workflow are measurable with
`eval/workflow_bench/` (real headless CLI runs, free-model routing supported — see its README).

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-07-20 | 1.14.0 | `gitnexus-review` gains a coordinated swarm: six `ci-personas/` lanes the CI review agent dispatches as subagents (via the `Agent` tool), with a bounded critic gate and sidechain-excluded evidence. |
| 2026-07-16 | 1.13.0 | `gitnexus-plan` asks plan depth up front (quick/standard/deep) in interactive runs; `gitnexus-lfg` gate slimmed to proceed/stop (Deepen stays as the route-back mechanism). |
| 2026-07-16 | 1.12.0 | Renamed `gitnexus-pr-review` to `gitnexus-review`; added PR URL/number, branch/range, and local-change targets plus install migration (setup warns on a legacy `gitnexus-pr-review` dir and leaves it in place; uninstall removes it). |
| 2026-07-11 | 1.11.0 | Skill family shipped via npm skills/ + plugin (sync-guarded); added eval/workflow_bench token-savings benchmark. |
| 2026-07-11 | 1.10.0 | Added `gitnexus-work` (plan executor) and `gitnexus-lfg` (plan → deepen/work gate → review pipeline) skills; section renamed to Engineering planning & execution. |
| 2026-07-11 | 1.9.0 | Added Engineering planning (`/gitnexus-plan`) section; registered the `gitnexus-plan` skill (`.claude/skills/gitnexus-plan/`). |
| 2026-05-22 | 1.8.0 | Kotlin added to `MIGRATED_LANGUAGES` (registry-primary call resolution by default). Closes #1756 (companion-vs-instance dispatch) and #1757 (lambda scopes); refs #1746. RFC §6.4 corpus criterion waived (corpus-mode wiring is #927-scope); fixture criterion met. |
| 2026-04-23 | 1.7.0 | TypeScript added to `MIGRATED_LANGUAGES` (registry-primary call resolution by default). |
| 2026-04-20 | 1.6.0 | Added scope-resolution pipeline pointer (RFC #909 Ring 3); Python migrated to registry-primary. |
| 2026-04-19 | 1.5.0 | Cross-repo impact (#794): `impact`/`query`/`context` accept `repo: "@<group>"` + `service`. Removed `group_query`/`group_contracts`/`group_status` MCP tools; added `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status` resources. |
| 2026-04-16 | 1.4.0 | Fixed: web UI description, pre-commit behavior, MCP tools (7->16), added gitnexus-shared, removed stale vite-plugin-wasm gotcha. |
| 2026-04-13 | 1.3.0 | Updated GitNexus index stats after DAG refactor. |
| 2026-03-24 | 1.2.0 | Fixed gitnexus:start block duplication. |
| 2026-03-23 | 1.1.0 | Updated agent instructions, references, Cursor layout. |
| 2026-03-22 | 1.0.0 | Initial structured header and changelog. |

---

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **GitNexus** (20319 symbols, 54304 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

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

- `npm install` in `gitnexus/` triggers `prepare` (builds via `tsc`) and `postinstall` (materializes the vendored grammars into `node_modules/`, then prefers a committed prebuild per platform-arch and only source-builds when none matches). A C/C++ toolchain (`python3`, `make`, `g++`) is needed only for that source-build fallback.
- The vendored grammars `tree-sitter-{c,dart,proto,swift,kotlin}` are handled uniformly: c is required; dart/proto/swift/kotlin are optional and skippable via `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1`. Install warnings appear only when no prebuild matches the platform-arch and no toolchain is present, and are non-fatal — only that language's parsing is unavailable.
- ESLint configured via `eslint.config.mjs` (TS, React Hooks, unused-imports). No `npm run lint` script; use `npx eslint .`. Prettier runs via lint-staged. CI checks both in `ci-quality.yml`.
